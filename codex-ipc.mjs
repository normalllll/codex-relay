// Client for the Codex desktop app's window-coordination pipe (\\.\pipe\codex-ipc).
// The app's windows use it to forward user input to the window that owns a thread's stream
// ("thread follower" requests). Steering through it adds a real user message to the running
// turn, exactly like typing in Codex, so question cards are marked answered.
// Frames are a u32 LE length followed by JSON.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { relayHome, ipcPipe, openUrlCommand } from "./paths.mjs";

// Each IPC method carries a protocol version; windows ignore requests whose version differs.
const OWNER_DISCOVERY_VERSION = 1;
const STEER_VERSION = 1;

function connect() {
  return new Promise((resolve, reject) => {
    // Resolve per connection: the desktop app may create its socket after this process starts.
    const socket = net.createConnection(ipcPipe());
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("codex-ipc connection timed out"), { delivery: "notSent" })); }, 5_000);
    socket.once("error", (error) => { clearTimeout(timer); socket.destroy(); reject(Object.assign(error, { delivery: "notSent" })); });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

class IpcClient {
  clientId = "initializing-client";
  pending = new Map();
  buffer = Buffer.alloc(0);

  constructor(socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("codex-ipc connection closed; delivery may be uncertain")));
  }

  write(message) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.length > 8 * 1024 * 1024) throw Object.assign(new Error("codex-ipc request exceeds 8 MiB"), { delivery: "notSent" });
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) return this.socket.destroy(new Error("codex-ipc response exceeds 8 MiB"));
      if (this.buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")); }
      catch { return this.socket.destroy(new Error("Invalid codex-ipc response")); }
      this.buffer = this.buffer.subarray(length + 4);
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message);
    } else if (message.type === "client-discovery-request") {
      // Never claim requests meant for the app's own windows.
      this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === "request") {
      this.write({ type: "response", requestId: message.requestId, resultType: "error", error: "no-handler" });
    }
  }

  request(method, params, { targetClientId, version = 0, timeoutMs = 10_000 } = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`codex-ipc ${method} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({
        type: "request",
        requestId,
        sourceClientId: this.clientId,
        version,
        method,
        params,
        targetClientId,
        timeoutMs,
      }); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  close() {
    this.fail(new Error("codex-ipc connection closed"));
    this.socket.destroy();
  }

  fail(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
}

// Only one relay process at a time may switch the Codex window to another thread; the others queue.
const LOCK_FILE = path.join(relayHome, "window.lock");
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5 * 60_000;
const OPEN_WAIT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withWindowLock(action) {
  fs.mkdirSync(relayHome, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        // A holder that crashed leaves the file behind; take it over once it is old enough.
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) fs.rmSync(LOCK_FILE, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("timed out waiting for another relay to release the Codex window");
      await sleep(500);
    }
  }
  try {
    return await action();
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

function openThreadInCodex(conversationId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) throw new Error("Invalid conversation ID for desktop navigation");
  const [command, args] = openUrlCommand(`codex://threads/${conversationId}`);
  return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true }, (error) => error ? reject(error) : resolve()));
}

async function findOwner(client, conversationId) {
  const owner = await client.request(
    "thread-owner-discovery",
    { hostId: "local", conversationId },
    { version: OWNER_DISCOVERY_VERSION },
  );
  return owner.resultType === "success" ? owner.handledByClientId : null;
}

// Adds `text` as a user message to the thread's in-progress turn, through the owning window.
// When no window is showing the thread, it is opened in Codex first (serialized across relays).
// `cwd` is the thread's working directory; the owner needs it for the composer draft it restores
// if the send fails.
export async function steerThread(conversationId, text, cwd, { allowOpen = false, messageId } = {}) {
  const client = new IpcClient(await connect());
  let attempted = false;
  try {
    const init = await client.request("initialize", { clientType: "codex-relay" });
    if (init.resultType !== "success") throw new Error(`codex-ipc initialize failed: ${init.error}`);
    client.clientId = init.result.clientId;

    const steer = async (ownerId) => {
      const clientUserMessageId = messageId ?? crypto.randomUUID();
      attempted = true;
      const steered = await client.request(
        "thread-follower-steer-turn",
        {
          conversationId,
          input: [{ type: "text", text, text_elements: [] }],
          restoreMessage: {
            id: clientUserMessageId,
            text,
            context: { cwd, workspaceRoots: cwd ? [cwd] : [], collaborationMode: null, commentAttachments: [] },
          },
          attachments: [],
          clientUserMessageId,
        },
        { targetClientId: ownerId, version: STEER_VERSION, timeoutMs: 30_000 },
      );
      if (steered.resultType !== "success") throw Object.assign(new Error(`steer failed: ${steered.error}`), { delivery: "notSent" });
      return { opened: false, ...steered.result };
    };

    const owner = await findOwner(client, conversationId);
    if (owner) return await steer(owner);
    if (!allowOpen) throw new Error("Target thread has no owning window. Opening Codex requires allowOpen:true with user authorization.");

    return await withWindowLock(async () => {
      // Another relay may have opened it while this one waited for the lock.
      let ownerId = await findOwner(client, conversationId);
      if (!ownerId) {
        await openThreadInCodex(conversationId);
        const deadline = Date.now() + OPEN_WAIT_MS;
        while (!ownerId && Date.now() < deadline) {
          await sleep(500);
          ownerId = await findOwner(client, conversationId);
        }
      }
      if (!ownerId) throw new Error(`no Codex window took ownership of thread ${conversationId}`);
      return { ...(await steer(ownerId)), opened: true };
    });
  } catch (error) {
    error.delivery ??= attempted ? "uncertain" : "notSent";
    throw error;
  } finally {
    client.close();
  }
}
