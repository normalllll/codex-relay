import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { relayHome, clearStaleSocket, restrictSocket } from "./paths.mjs";
import { daemonPipe, daemonToken, daemonRequest, serviceStatus, startService } from "./daemon-client.mjs";
import { WatchStore } from "./watch-store.mjs";
import { WatchEngine } from "./watch-engine.mjs";
import { createWakeHost } from "./host-wake.mjs";
import { status } from "./codex-client.mjs";

const self = fileURLToPath(import.meta.url);
const stopFile = path.join(relayHome, "watch-stop");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function acquire(name) {
  fs.mkdirSync(relayHome, { recursive: true });
  const file = path.join(relayHome, name);
  const identity = { pid: process.pid, nonce: crypto.randomUUID() };
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, JSON.stringify(identity), { flag: "wx", mode: 0o600 }); return () => {
      try { if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === identity.nonce) fs.unlinkSync(file); } catch {}
    }; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch {
        if (Date.now() - fs.statSync(file).mtimeMs < 30_000) throw new Error(`${name} is incomplete; recovery will retry after its stale interval`);
        fs.unlinkSync(file); continue;
      }
      if (alive(owner.pid)) return null;
      fs.unlinkSync(file);
    }
  }
  throw new Error(`Could not acquire ${name}`);
}

export async function runDaemon({ pollMs = 2_000 } = {}) {
  const unlock = acquire("watch-worker.lock");
  if (!unlock) return { ok: true, alreadyRunning: true };
  const token = daemonToken(true);
  const controller = new AbortController();
  const store = new WatchStore();
  const channels = new Map(), receipts = new Map(), sockets = new Set();
  const sendChannel = (sessionId, event, prompt) => new Promise((resolve, reject) => {
    const socket = channels.get(sessionId);
    if (!socket || socket.destroyed) return resolve(false);
    const receiptId = crypto.randomUUID();
    const timer = setTimeout(() => {
      receipts.delete(receiptId);
      reject(Object.assign(new Error("Channel notification delivery is uncertain; the receiver did not confirm transport receipt"), { delivery: "uncertain" }));
    }, 5_000);
    receipts.set(receiptId, { socket, timer, resolve, reject });
    socket.write(JSON.stringify({ method: "channel/event", params: { receiptId, eventId: event.id, subscriptionId: event.subscriptionId, threadId: event.threadId, content: prompt } }) + "\n");
  });
  const wake = createWakeHost({ sendChannel, signal: controller.signal });
  const engine = new WatchEngine({ store, status, wake, pollMs });
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      for (const [key, value] of channels) if (value === socket) channels.delete(key);
      for (const [id, entry] of receipts) if (entry.socket === socket) {
        clearTimeout(entry.timer); receipts.delete(id); entry.reject(Object.assign(new Error("Channel disconnected after notification dispatch"), { delivery: "uncertain" }));
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk; if (buffer.length > 8 * 1024 * 1024) return socket.destroy();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request;
        try {
          request = JSON.parse(line);
          if (request?.token !== token) throw new Error("Invalid watch service token");
          const p = request.params ?? {};
          let result;
          switch (request.method) {
            case "status": result = { ok: true, running: true, stopping: controller.signal.aborted, pid: process.pid, subscriptions: store.list().length, channelSessions: [...channels.keys()] }; break;
            case "subscribe": result = store.subscribe(p); break;
            case "list": result = store.list(); break;
            case "events": result = store.events(p); break;
            case "ack": result = store.ack(p); break;
            case "remove": result = store.remove(p.subscriptionId); break;
            case "stop": result = { ok: true, stopping: true }; setTimeout(() => controller.abort(), 30); break;
            case "channel/open": {
              if (typeof p.sessionId !== "string" || !p.sessionId.trim()) throw new Error("channel/open requires sessionId");
              const previous = channels.get(p.sessionId);
              if (previous && previous !== socket && !previous.destroyed) throw new Error("A channel for this session is already connected");
              channels.set(p.sessionId, socket); result = { connected: true }; break;
            }
            case "channel/receipt": {
              const entry = receipts.get(p.receiptId);
              if (!entry || entry.socket !== socket) throw new Error("Unknown channel receipt");
              clearTimeout(entry.timer); receipts.delete(p.receiptId); entry.resolve({ delivered: true });
              result = { accepted: true }; break;
            }
            default: throw new Error("Unknown watch service method");
          }
          if (request.id !== undefined) socket.write(JSON.stringify({ id: request.id, result }) + "\n");
        } catch (error) {
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request?.id ?? null, error: { message: error.message, delivery: "notSent" } }) + "\n");
        }
      }
    });
  });
  const stop = () => controller.abort();
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    // The worker lock is held, so a leftover Unix socket belongs to a crashed worker.
    await clearStaleSocket(daemonPipe);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(daemonPipe, resolve); });
    restrictSocket(daemonPipe);
    await engine.run({ signal: controller.signal });
    return { ok: true, stopped: true };
  } finally {
    controller.abort();
    for (const socket of sockets) socket.destroy();
    for (const entry of receipts.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error("Watch service stopped"), { delivery: "uncertain" })); }
    await new Promise((resolve) => server.close(resolve));
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); unlock();
  }
}

async function supervise() {
  const unlock = acquire("watch-supervisor.lock");
  if (!unlock) return { ok: true, alreadyRunning: true };
  let child, stopping = false;
  const stop = () => { stopping = true; child?.kill(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  let failures = 0;
  try {
    while (!stopping && !fs.existsSync(stopFile)) {
      const started = Date.now();
      const code = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [self, "run"], { env: process.env, windowsHide: true, stdio: "inherit" });
        child.once("error", reject); child.once("exit", resolve);
      });
      if (code === 0 || stopping || fs.existsSync(stopFile)) break;
      failures = Date.now() - started > 60_000 ? 0 : failures + 1;
      const until = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
      while (!stopping && !fs.existsSync(stopFile) && Date.now() < until) await pause(100);
    }
    return { ok: true, stopped: true };
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); unlock(); }
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "status"] = argv;
  if (argv.length > 1) throw new Error("daemon accepts only start, stop, status, run, or supervise");
  if (command === "status") return serviceStatus();
  if (command === "start") { fs.mkdirSync(relayHome, { recursive: true }); fs.rmSync(stopFile, { force: true }); return startService(); }
  if (command === "run") return runDaemon();
  if (command === "supervise") return supervise();
  if (command === "stop") {
    fs.mkdirSync(relayHome, { recursive: true }); fs.writeFileSync(stopFile, new Date().toISOString());
    const running = await serviceStatus();
    if (running.running) await daemonRequest("stop");
    for (let i = 0; i < 60; i++) {
      const worker = await serviceStatus();
      let supervisorAlive = false;
      try { supervisorAlive = alive(JSON.parse(fs.readFileSync(path.join(relayHome, "watch-supervisor.lock"), "utf8")).pid); } catch {}
      if (!worker.running && !supervisorAlive) return { ok: true, running: false };
      await pause(100);
    }
    throw new Error("Watch service did not stop in time; installation was not changed");
  }
  throw new Error("Unknown daemon command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
