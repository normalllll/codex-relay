// Codex Relay: an MCP server loaded by the Codex desktop app.
// It inherits the app's private tools pipe (CODEX_APP_TOOLS_PIPE_PATH) and re-exposes
// tools/list and tools/call on a token-protected local named pipe for external agents.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { relayHome, controlPipe, tokenFile, clearStaleSocket, restrictSocket } from "./paths.mjs";

const STATE_DIR = relayHome;
const TOKEN_FILE = tokenFile;
const LOG_FILE = path.join(STATE_DIR, "relay.log");
const CONTROL_PIPE = controlPipe;
const APP_PIPE = process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim() || null;
const HOST_ID = process.env.CODEX_APP_TOOLS_CALLER_HOST_ID?.trim() || undefined;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const ALLOWED_METHODS = new Set(["relay/info", "tools/list", "tools/call"]);
const ALLOWED_TOOLS = new Set(["list_projects", "list_threads", "create_thread", "read_thread", "wait_threads", "send_message_to_thread"]);

fs.mkdirSync(STATE_DIR, { recursive: true });
const log = (msg) =>
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);

function loadToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  }
  return token;
}
const TOKEN = loadToken();

// ---- Client for the app's private pipe (u32 LE length-prefixed JSON-RPC) ----
class AppPipeClient {
  socket = null;
  connecting = null;
  nextId = 1;
  pending = new Map();
  buffer = Buffer.alloc(0);

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (!APP_PIPE) return Promise.reject(Object.assign(new Error("CODEX_APP_TOOLS_PIPE_PATH was not provided"), { delivery: "notSent" }));
    this.connecting ??= new Promise((resolve, reject) => {
      const socket = net.createConnection(APP_PIPE);
      const timer = setTimeout(() => socket.destroy(new Error("app pipe connection timed out")), 5_000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        this.connecting = null;
        reject(Object.assign(error, { delivery: "notSent" }));
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        this.socket = socket;
        this.connecting = null;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => this.drop(error));
        socket.on("close", () => this.drop(new Error("app pipe closed")));
        resolve();
      });
    });
    return this.connecting;
  }

  async request(method, params) {
    await this.connect();
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, jsonrpc: "2.0", method, params }), "utf8");
    if (payload.length > MAX_FRAME_BYTES) throw Object.assign(new Error("request too large"), { delivery: "notSent" });
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("app tool timed out; check task status before retrying a write"));
      }, 35_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame);
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) return this.socket.destroy(new Error("response too large"));
      if (this.buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")); }
      catch { return this.socket.destroy(new Error("invalid app pipe response")); }
      this.buffer = this.buffer.subarray(length + 4);
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending.resolve(message.result);
    }
  }

  drop(error) {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
const app = new AppPipeClient();

// ---- Control pipe for external agents (newline-delimited JSON) ----
let ownsControlPipe = false;

async function handleControl(request) {
  if (request.token !== TOKEN) throw new Error("invalid token");
  if (!ALLOWED_METHODS.has(request.method)) throw new Error(`method not allowed: ${request.method}`);
  if (request.method === "relay/info")
    return { pid: process.pid, version: "0.6.0", appPipe: APP_PIPE != null, hostId: HOST_ID ?? null };
  if (request.method === "tools/list")
    return app.request("tools/list", { threadStartKind: "all", ...request.params });
  const p = request.params ?? {};
  if (!p.tool || !p.threadId) throw new Error("tools/call needs tool and threadId");
  if (!ALLOWED_TOOLS.has(p.tool) || (p.namespace && p.namespace !== "codex_app"))
    throw new Error(`tool not allowed: ${p.tool}`);
  if (p.hostId && p.hostId !== "local" && p.hostId !== HOST_ID) throw new Error("remote host is not supported");
  return app.request("tools/call", {
    arguments: p.arguments ?? {},
    callerSource: "codex",
    callId: `relay-call-${crypto.randomUUID()}`,
    hostId: p.hostId ?? HOST_ID,
    namespace: p.namespace,
    threadId: p.threadId,
    tool: p.tool,
    turnId: p.turnId ?? `relay-turn-${crypto.randomUUID()}`,
  });
}

function startControlServer() {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    // Bound incoming frames before buffering; clients use one JSON line per connection.
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) return socket.destroy();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        void respond(line);
      }
    });
    async function respond(line) {
      let request;
      try {
        request = JSON.parse(line);
        const result = await handleControl(request);
        if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (error) {
        log(`control error: ${error.message}`);
        if (!socket.destroyed) socket.write(
          `${JSON.stringify({ id: request?.id ?? null, error: { message: error.message, code: error.code, delivery: error.delivery ?? (/invalid token|method not allowed|tool not allowed|needs tool|remote host/.test(error.message) ? "notSent" : "uncertain") } })}\n`,
        );
      }
    }
    socket.on("error", () => {});
  });
  server.once("error", (error) => {
    // Codex starts one MCP process per thread; only one owns the control pipe, the rest wait.
    // A Unix socket left by a crashed owner is removed so a waiting process can take over.
    if (error.code === "EADDRINUSE") void clearStaleSocket(CONTROL_PIPE).then((cleared) => setTimeout(startControlServer, cleared ? 0 : 5_000).unref());
    else log(`control server error: ${error.message}`);
  });
  server.listen(CONTROL_PIPE, () => {
    restrictSocket(CONTROL_PIPE);
    ownsControlPipe = true;
    log(`listening on ${CONTROL_PIPE}; app pipe ${APP_PIPE ? "available" : "MISSING"}`);
  });
}
// A standalone process without the app environment must not occupy the real bridge pipe.
if (APP_PIPE) startControlServer();

// ---- Minimal MCP stdio server so Codex accepts this as a plugin ----
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message))
    return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-relay-bridge", version: "0.6.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: [
          {
            name: "relay_status",
            description: "Report whether the Codex Relay control pipe is active. Diagnostic only.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    case "tools/call":
      if (message.params?.name !== "relay_status") return reply({ isError: true, content: [{ type: "text", text: "Unknown tool" }] });
      return reply({
        content: [
          {
            type: "text",
            text: JSON.stringify({ pid: process.pid, ownsControlPipe, appPipe: APP_PIPE != null }),
          },
        ],
      });
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
process.stdin.on("end", () => process.exit(0));
log(`started; app pipe ${APP_PIPE ? "present" : "missing"}`);
