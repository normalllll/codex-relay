// Client for the Codex desktop app's window-coordination pipe (\\.\pipe\codex-ipc).
// The app's windows use it to forward user input to the window that owns a thread's stream
// ("thread follower" requests). Normal submissions use the composer's start/steer operations;
// structured question replies also use steering so the host can close their cards.
// Frames are a u32 LE length followed by JSON.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { relayHome, ipcPipe, openUrlCommand } from "../runtime/paths.mjs";

// Each IPC method carries a protocol version; windows ignore requests whose version differs.
const OWNER_DISCOVERY_VERSION = 1;
const STEER_VERSION = 1;
const START_VERSION = 2;
const MODEL_SETTINGS_VERSION = 1;
const FOLLOWING_VERSION = 1;
const STATE_SNAPSHOT_VERSION = 11;

function assertSubmissionResult(result, ownerId, method) {
  if (result.handledByClientId !== ownerId || result.method !== method)
    throw Object.assign(new Error("The desktop input response came from an unexpected owner or protocol"), { delivery: "uncertain" });
  if (result.resultType !== "success") {
    // These rejections precede submission. Other failures can follow an accepted write.
    const rejected = /^(?:no-handler|no-client-found|no active turn to steer)(?::.*)?$/i.test(String(result.error)) ||
      /^Cannot steer conversation \S+ because its active turn already ended$/.test(String(result.error));
    throw Object.assign(new Error(`Desktop input failed: ${result.error}`), { delivery: rejected ? "notSent" : "uncertain" });
  }
  // The owner wraps the app-server result in {result}. A routed IPC acknowledgment alone
  // does not establish that the start/steer operation accepted a turn.
  const accepted = result.result?.result;
  const turnId = method === "thread-follower-start-turn" ? accepted?.turn?.id : accepted?.turnId;
  if (typeof turnId !== "string" || !turnId.trim())
    throw Object.assign(new Error("The desktop input response did not confirm an accepted turn"), { delivery: "uncertain" });
}

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
  snapshots = new Set();
  buffer = Buffer.alloc(0);

  constructor(socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("codex-ipc connection closed; delivery may be uncertain")));
  }

  write(message, onWritten) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.length > 8 * 1024 * 1024) throw Object.assign(new Error("codex-ipc request exceeds 8 MiB"), { delivery: "notSent" });
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame, onWritten);
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
      if (!message || typeof message !== "object" || Array.isArray(message)) return this.socket.destroy(new Error("Invalid codex-ipc response"));
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
    } else if (message.type === "broadcast" && message.method === "thread-stream-state-changed") {
      for (const entry of this.snapshots) {
        if (message.sourceClientId !== entry.ownerId || message.params?.hostId !== "local" ||
            message.params?.conversationId !== entry.threadId || message.params?.change?.type !== "snapshot") continue;
        clearTimeout(entry.timer); this.snapshots.delete(entry);
        const state = message.params.change.conversationState;
        if (message.version !== STATE_SNAPSHOT_VERSION || state?.id !== entry.threadId || state.hostId !== "local" ||
            !Number.isSafeInteger(message.params.change.revision) || message.params.change.revision < 0) {
          entry.reject(new Error("Unsupported or mismatched desktop session snapshot"));
          continue;
        }
        if (entry.project) {
          try { entry.resolve(entry.project(state)); } catch (error) { entry.reject(error); }
          continue;
        }
        // Only current session settings leave this reader; transcript and permission data are discarded.
        const settings = state.latestThreadSettings;
        const available = state.resumeState === "resumed" && settings && typeof settings === "object" &&
          !Array.isArray(settings) && Object.hasOwn(settings, "serviceTier");
        const tier = settings?.serviceTier;
        entry.resolve({ threadId: entry.threadId, available: Boolean(available),
          ...(available ? { serviceTier: typeof tier === "string" && tier.length <= 100 ? tier : null }
            : { reason: "Current session settings do not expose a settled service tier",
                ...(state.resumeState !== "resumed" ? { reasonCode: "SESSION_SETTINGS_UNSETTLED" } : {}) }),
          protocolVersion: message.version, revision: message.params.change.revision });
      }
    }
  }

  setFollowing(threadId, ownerId, following, onWritten) {
    this.write({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: this.clientId,
      targetClientIds: [ownerId], version: FOLLOWING_VERSION, params: { hostId: "local", conversationId: threadId, following } }, onWritten);
  }

  sessionSnapshot(threadId, ownerId, timeoutMs, project) {
    return new Promise((resolve, reject) => {
      const entry = { threadId, ownerId, resolve, reject, project };
      entry.timer = setTimeout(() => { this.snapshots.delete(entry); reject(new Error("Desktop session snapshot timed out")); }, timeoutMs);
      this.snapshots.add(entry);
      try { this.setFollowing(threadId, ownerId, true); }
      catch (error) { clearTimeout(entry.timer); this.snapshots.delete(entry); reject(error); }
    });
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
    for (const { reject, timer } of this.snapshots) { clearTimeout(timer); reject(error); }
    this.snapshots.clear();
  }
}

// The model-settings request is a pending-update barrier but currently omits the tier.
// The owner's existing state-sync snapshot includes latestThreadSettings.serviceTier.
export async function readSessionPolicy(threadId) {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(threadId)) throw new Error("Invalid thread identifier");
  const deadline = Date.now() + 5_000;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error("Desktop session settings read timed out");
    return value;
  };
  const client = new IpcClient(await connect());
  let ownerId, following = false;
  try {
    const init = await client.request("initialize", { clientType: "codex-relay" }, { timeoutMs: remaining() });
    if (init.resultType !== "success" || typeof init.result?.clientId !== "string") throw new Error("Desktop settings connection initialization failed");
    client.clientId = init.result.clientId;
    const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: threadId },
      { version: OWNER_DISCOVERY_VERSION, timeoutMs: remaining() });
    if (owner.resultType !== "success" || typeof owner.handledByClientId !== "string")
      return { threadId, available: false, reason: "The selected session has no loaded desktop owner" };
    ownerId = owner.handledByClientId;
    const barrier = await client.request("thread-follower-read-model-settings", { conversationId: threadId },
      { targetClientId: ownerId, version: MODEL_SETTINGS_VERSION, timeoutMs: remaining() });
    if (barrier.resultType !== "success" || barrier.handledByClientId !== ownerId ||
        barrier.method !== "thread-follower-read-model-settings" || !barrier.result?.settings)
      throw new Error("The desktop owner could not settle this session's settings");
    following = true;
    return await client.sessionSnapshot(threadId, ownerId, remaining());
  } finally {
    if (following && !client.socket.destroyed && client.socket.writable) {
      // Flush the unsubscribe before closing; disconnect is also handled by the host's normal cleanup.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 250);
        const done = () => { clearTimeout(timer); resolve(); };
        try { client.setFollowing(threadId, ownerId, false, done); } catch { done(); }
      });
    }
    client.close();
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

function submissionState(state) {
  if (state.resumeState !== "resumed") throw new Error("The desktop session has not finished resuming");
  if (state.unconfirmedTurnSubmissions?.length) throw new Error("An earlier turn submission is not yet confirmed");
  const runtime = state.threadRuntimeStatus?.type;
  // systemError records a failed run, not an active turn or an input prohibition.
  // Offer the normal start operation; the owner still decides whether to accept it.
  if (runtime === "active" || runtime === "idle" || runtime === "systemError") return { active: runtime === "active" };
  if (runtime != null) throw new Error(`The desktop session cannot accept input in state ${runtime}`);
  // Canonical histories can keep a stale legacy turns array. Do not infer idleness from it.
  if (state.turnHistory?.kind === "canonical" || !Array.isArray(state.turns))
    throw new Error("The desktop snapshot does not expose the current input state");
  const latest = state.turns.at(-1);
  if (!latest) return { active: false };
  if (latest.status === "inProgress") return { active: true };
  if (["completed", "failed", "interrupted"].includes(latest.status)) return { active: false };
  throw new Error("The desktop snapshot has an unknown turn state");
}

// Submit work through the same owner-side start/steer operations as the composer.
// Source identity, authorization history and monitoring metadata never enter the input.
export async function submitThread(conversationId, text, cwd, { allowOpen = false, messageId } = {}) {
  if (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(conversationId)) throw Object.assign(new Error("Invalid thread identifier"), { delivery: "notSent" });
  if (typeof text !== "string" || !text.trim()) throw Object.assign(new Error("Message must contain work instructions"), { delivery: "notSent" });
  const client = new IpcClient(await connect());
  let attempted = false, followingOwner;
  const unsubscribe = async () => {
    if (!followingOwner || client.socket.destroyed || !client.socket.writable) return;
    const ownerId = followingOwner; followingOwner = undefined;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      const done = () => { clearTimeout(timer); resolve(); };
      try { client.setFollowing(conversationId, ownerId, false, done); } catch { done(); }
    });
  };
  try {
    const init = await client.request("initialize", { clientType: "codex-relay" });
    if (init.resultType !== "success" || typeof init.result?.clientId !== "string") throw new Error("Desktop input connection initialization failed");
    client.clientId = init.result.clientId;
    const submit = async (ownerId) => {
      followingOwner = ownerId;
      const current = await client.sessionSnapshot(conversationId, ownerId, 5_000, submissionState);
      await unsubscribe();
      const clientUserMessageId = messageId ?? crypto.randomUUID();
      const restoreMessage = { id: clientUserMessageId, text,
        context: { cwd, workspaceRoots: cwd ? [cwd] : [], collaborationMode: null, commentAttachments: [] } };
      const input = [{ type: "text", text, text_elements: [] }];
      const method = current.active ? "thread-follower-steer-turn" : "thread-follower-start-turn";
      const params = current.active ? { conversationId, input, restoreMessage, attachments: [], clientUserMessageId }
        : { conversationId, turnStart: { request: { threadId: conversationId, input, clientUserMessageId },
          context: { inheritThreadSettings: true, restoreMessage } } };
      attempted = true;
      const result = await client.request(method, params, { targetClientId: ownerId,
        version: current.active ? STEER_VERSION : START_VERSION, timeoutMs: 30_000 });
      assertSubmissionResult(result, ownerId, method);
      return { opened: false, method };
    };
    const owner = await findOwner(client, conversationId);
    if (typeof owner === "string" && owner) return await submit(owner);
    if (!allowOpen) throw new Error("Target thread has no owning window. Opening Codex requires allowOpen:true with user authorization.");
    return await withWindowLock(async () => {
      let ownerId = await findOwner(client, conversationId), opened = false;
      if (!ownerId) {
        await openThreadInCodex(conversationId); opened = true;
        const deadline = Date.now() + OPEN_WAIT_MS;
        while (!ownerId && Date.now() < deadline) { await sleep(500); ownerId = await findOwner(client, conversationId); }
      }
      if (!ownerId) throw new Error(`no Codex window took ownership of thread ${conversationId}`);
      return { ...await submit(ownerId), opened };
    });
  } catch (error) {
    error.delivery ??= attempted ? "uncertain" : "notSent";
    throw error;
  } finally {
    await unsubscribe();
    client.close();
  }
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
      assertSubmissionResult(steered, ownerId, "thread-follower-steer-turn");
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
