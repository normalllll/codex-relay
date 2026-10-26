import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relayHome, unixSocket } from "../runtime/paths.mjs";

const identity = crypto.createHash("sha256").update(relayHome.toLowerCase()).digest("hex").slice(0, 20);
// Unix sockets stay in the private relay home rather than a shared temporary directory.
export const daemonPipe = process.env.CODEX_RELAY_DAEMON_PIPE || (process.platform === "win32" ? `\\\\.\\pipe\\codex-relay-watch-${identity}`
  : (() => { try { return unixSocket(relayHome, "watch.sock"); } catch { return path.join(relayHome, "watch.sock"); } })());
export const daemonTokenFile = path.join(relayHome, "daemon-token");
export function daemonToken(create = false) {
  if (create) {
    fs.mkdirSync(relayHome, { recursive: true });
    try { fs.writeFileSync(daemonTokenFile, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return fs.readFileSync(daemonTokenFile, "utf8").trim();
}

export function daemonRequest(method, params = {}, { timeoutMs = 5_000 } = {}) {
  let token;
  try { token = daemonToken(); } catch { return Promise.reject(Object.assign(new Error("Watch service is not initialized"), { delivery: "notSent" })); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(daemonPipe);
    socket.setEncoding("utf8");
    let buffer = "", attempted = false, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) { error.delivery ??= attempted ? "uncertain" : "notSent"; reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Watch service request timed out")), timeoutMs);
    socket.once("error", (error) => finish(error));
    socket.once("close", () => { if (!settled) finish(new Error("Watch service disconnected")); });
    socket.once("connect", () => { attempted = true; socket.write(JSON.stringify({ id: 1, token, method, params }) + "\n"); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return finish(new Error("Watch service response exceeds 8 MiB"));
      const end = buffer.indexOf("\n"); if (end < 0) return;
      try { const message = JSON.parse(buffer.slice(0, end)); finish(message.error ? Object.assign(new Error(message.error.message), { delivery: message.error.delivery }) : null, message.result); }
      catch (error) { finish(error); }
    });
  });
}

export async function serviceStatus() {
  try { return await daemonRequest("status", {}, { timeoutMs: 1_000 }); }
  catch (error) { return { ok: true, running: false, error: error.message }; }
}

export async function startService({ resume = false } = {}) {
  const stopFile = path.join(relayHome, "watch-stop");
  if (resume) fs.rmSync(stopFile, { force: true });
  else if (fs.existsSync(stopFile)) throw new Error("Watch service was intentionally stopped. Run service start or register a new watch to resume it.");
  let running = await serviceStatus();
  if (running.running && !running.stopping) return running;
  for (let i = 0; running.stopping && i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100)); running = await serviceStatus();
  }
  if (running.stopping) throw new Error("Watch service is still shutting down; retry after it stops");
  daemonToken(true);
  const log = fs.openSync(path.join(relayHome, "watch-service.log"), "a");
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../daemon.mjs", import.meta.url)), "supervise"], {
      env: { ...process.env, CODEX_RELAY_HOME: relayHome }, detached: true, windowsHide: true, stdio: ["ignore", log, log],
    });
    let failed;
    child.once("error", (error) => { failed = error; }); child.unref();
    for (let i = 0; i < 50; i++) {
      if (failed) throw failed;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await serviceStatus(); if (result.running) return result;
    }
    throw new Error("Watch supervisor started but its worker did not become ready; inspect watch-service.log");
  } finally { fs.closeSync(log); }
}

// Persistent local channel transport. It reconnects after worker restart without losing subscriptions.
export function connectChannel(sessionId, onEvent, { onError = () => {} } = {}) {
  let closed = false, socket, retry;
  const connect = () => {
    if (closed) return;
    let token;
    try { token = daemonToken(); } catch (error) { onError(error); retry = setTimeout(connect, 1_000); return; }
    const connection = net.createConnection(daemonPipe); socket = connection; connection.setEncoding("utf8");
    let buffer = "";
    connection.on("error", onError);
    connection.on("close", () => { if (!closed) retry = setTimeout(connect, 1_000); });
    connection.on("connect", () => connection.write(JSON.stringify({ id: "channel", token, method: "channel/open", params: { sessionId } }) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return connection.destroy();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        void (async () => {
          try {
            const message = JSON.parse(line);
            if (message.error) throw new Error(message.error.message);
            if (message.method !== "channel/event") return;
            await onEvent(message.params);
            if (!connection.destroyed) connection.write(JSON.stringify({ token, method: "channel/receipt", params: { receiptId: message.params.receiptId } }) + "\n");
          } catch (error) { onError(error); connection.destroy(); }
        })();
      }
    });
  };
  connect();
  return () => { closed = true; clearTimeout(retry); socket?.destroy(); };
}
