import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { isMissingProcess } from "./process-state.mjs";

const clone = (value) => structuredClone(value);
const terminalPhases = new Set(["acknowledged"]);
const activePhases = new Set(["dispatching", "delivered", "uncertain"]);
const endedTurnStatuses = new Set(["completed", "failed", "interrupted", "cancelled", "canceled"]);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const hash = (value) => crypto.createHash("sha256").update(canonical(value)).digest("hex");
export function supervisorKey(supervisor) {
  return `${supervisor.host}:${supervisor.threadId ?? supervisor.sessionId ?? hash(supervisor)}`;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isMissingProcess(error); }
}

function atomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

const delaySync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Windows can report a sharing violation as EPERM/EACCES while another process
// is creating or deleting an exclusive lock. Retry within the existing deadline.
const lockContention = (error) => error.code === "EEXIST" ||
  (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code));

/** Durable local outbox. All mutations are serialized across Node/Bun processes. */
export class WatchStore {
  constructor(home = process.env.CODEX_RELAY_HOME || path.join(os.homedir(), ".codex-relay"), { lockTimeoutMs = 2_000, malformedLockStaleMs = 30_000 } = {}) {
    this.home = path.resolve(home);
    this.directory = path.join(this.home, "watches");
    this.file = path.join(this.directory, "state.json");
    this.lock = path.join(this.directory, "state.lock");
    this.reclaimLock = path.join(this.directory, "reclaim.lock");
    this.lockTimeoutMs = lockTimeoutMs;
    this.malformedLockStaleMs = malformedLockStaleMs;
  }

  transaction(change, { write = true } = {}) {
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error("Watch state directory must not be a symlink");
    const until = Date.now() + this.lockTimeoutMs;
    const identity = { pid: process.pid, nonce: crypto.randomUUID(), createdAt: Date.now() };
    let fd;
    while (fd === undefined) {
      try { fd = fs.openSync(this.lock, "wx", 0o600); }
      catch (error) {
        if (!lockContention(error)) throw error;
        const reclaimError = this.reclaimDeadLock();
        if (Date.now() >= until) {
          if (reclaimError) throw reclaimError;
          if (error.code !== "EEXIST") throw error;
          throw new Error("Watch state is busy; retry this local operation");
        }
        delaySync(10);
      }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(identity));
      let state;
      try { state = JSON.parse(fs.readFileSync(this.file, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Watch state cannot be read; it was preserved: ${error.message}`);
        state = { schemaVersion: 1, revision: 0, subscriptions: {}, events: {} };
      }
      if (state.schemaVersion !== 1 || !state.subscriptions || !state.events) throw new Error("Unsupported watch state schema; state was preserved");
      const before = write ? JSON.stringify(state) : null;
      const result = change(state);
      if (write && JSON.stringify(state) !== before) { state.revision++; atomic(this.file, state); }
      return clone(result);
    } finally {
      fs.closeSync(fd);
      // Only remove our own lock, even if the caller changed state unexpectedly.
      try { if (JSON.parse(fs.readFileSync(this.lock, "utf8")).nonce === identity.nonce) fs.unlinkSync(this.lock); } catch {}
    }
  }

  reclaimDeadLock() {
    // Most contention is a live transaction. Avoid racing on the reclaim guard
    // unless the observed owner is dead or an incomplete lock is actually stale.
    try {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(this.lock, "utf8")); }
      catch (error) {
        if (error.code === "ENOENT") return;
        if (Date.now() - fs.statSync(this.lock).mtimeMs <= this.malformedLockStaleMs) return;
      }
      if (owner && alive(owner.pid)) return;
    } catch (error) { if (lockContention(error) || error.code === "ENOENT") return; throw error; }
    let guard;
    try { guard = fs.openSync(this.reclaimLock, "wx", 0o600); }
    catch (error) {
      if (!lockContention(error)) throw error;
      // Reclaim guards contain no state and are held only for synchronous operations.
      try { if (Date.now() - fs.statSync(this.reclaimLock).mtimeMs > this.malformedLockStaleMs) fs.unlinkSync(this.reclaimLock); } catch {}
      return error.code === "EEXIST" ? undefined : error;
    }
    try {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(this.lock, "utf8")); }
      catch {
        try { if (Date.now() - fs.statSync(this.lock).mtimeMs > this.malformedLockStaleMs) fs.unlinkSync(this.lock); } catch {}
        return;
      }
      if (!alive(owner.pid)) { try { fs.unlinkSync(this.lock); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    } finally { fs.closeSync(guard); fs.unlinkSync(this.reclaimLock); }
  }

  subscribe(input) {
    if (!input || typeof input.threadId !== "string" || !input.threadId.trim()) throw new Error("threadId is required");
    if (!input.supervisor || !["codex", "claude"].includes(input.supervisor.host)) throw new Error("supervisor.host must be codex or claude");
    if (input.supervisor.host === "codex" && input.supervisor.threadId === input.threadId) throw new Error("A watched thread cannot supervise itself");
    const id = input.id ?? `watch_${hash({ threadId: input.threadId, supervisor: input.supervisor }).slice(0, 24)}`;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid watch subscription ID");
    return this.transaction((state) => {
      const previous = state.subscriptions[id];
      if (previous && (previous.threadId !== input.threadId || canonical(previous.supervisor) !== canonical(input.supervisor))) throw new Error("Subscription identity is immutable; use a new ID for another target or supervisor");
      const now = Date.now();
      state.subscriptions[id] = {
        ...previous, ...clone(input), id, enabled: input.enabled ?? true,
        createdAt: previous?.createdAt ?? now, updatedAt: now,
        seenQuestions: previous?.seenQuestions ?? [], generation: previous?.generation ?? 0,
      };
      return state.subscriptions[id];
    });
  }

  list() { return this.transaction((state) => Object.values(state.subscriptions), { write: false }); }

  remove(id) {
    return this.transaction((state) => {
      const existed = Boolean(state.subscriptions[id]);
      delete state.subscriptions[id];
      for (const event of Object.values(state.events)) if (event.subscriptionId === id && !terminalPhases.has(event.phase)) {
        event.phase = "acknowledged"; event.action = "complete"; event.acknowledgedAt = Date.now(); event.reason = "subscriptionRemoved";
      }
      return { removed: existed, subscriptionId: id };
    });
  }

  events({ subscriptionId, includeAcknowledged = false } = {}) {
    return this.transaction((state) => Object.values(state.events).filter((event) => (!subscriptionId || event.subscriptionId === subscriptionId) && (includeAcknowledged || !terminalPhases.has(event.phase))), { write: false });
  }

  ack({ eventId, action = "rearm", now = Date.now() }) {
    if (!["rearm", "complete", "retry"].includes(action)) throw new Error("action must be rearm, complete, or retry");
    return this.transaction((state) => {
      const event = state.events[eventId];
      if (!event) throw new Error("Unknown watch event");
      if (event.phase === "acknowledged") return event;
      if (action === "retry") {
        if (!["uncertain", "delivered"].includes(event.phase)) throw new Error("Only uncertain or delivered events need explicit retry authorization");
        event.phase = "pending"; event.nextAttemptAt = now; event.explicitRetryAt = now;
      } else {
        event.phase = "acknowledged"; event.acknowledgedAt = now; event.action = action;
        if (action === "complete" && state.subscriptions[event.subscriptionId]) state.subscriptions[event.subscriptionId].enabled = false;
      }
      return event;
    });
  }

  /** Observe one subscription. Stable identities retain deduplication after restarts. */
  observe(subscriptionId, snapshot, { now = Date.now() } = {}) {
    return this.transaction((state) => {
      const subscription = state.subscriptions[subscriptionId];
      if (!subscription?.enabled) return [];
      subscription.lastPollAt = now;
      delete subscription.lastError; delete subscription.nextPollAt; subscription.pollFailures = 0;
      if (snapshot.threadStatus === "unavailable") { subscription.lastError = snapshot.error ?? "Thread unavailable"; return []; }
      const inProgress = snapshot.turnStatus === "inProgress";
      if (inProgress && subscription.wasInProgress !== true) subscription.generation++;
      subscription.wasInProgress = inProgress;
      const turnId = snapshot.turnId ?? snapshot.latestTurn?.id ?? snapshot.latestMessage?.turnId ?? `generation:${subscription.generation}`;
      const added = [];
      const enqueue = (type, fingerprint, payload) => {
        const id = `event_${hash({ subscriptionId, type, turnId, fingerprint })}`;
        if (state.events[id]) return;
        const event = { id, eventId: id, subscriptionId, threadId: subscription.threadId, supervisor: clone(subscription.supervisor), type, turnId,
          phase: "pending", createdAt: now, nextAttemptAt: now, attempts: 0, payload: clone(payload) };
        state.events[id] = event; added.push(event);
      };
      const questions = snapshot.questions ?? [];
      const seen = new Set(subscription.seenQuestions);
      const fresh = questions.filter((question) => !seen.has(`${turnId}:${question.callId}:${question.index}`));
      if (fresh.length) {
        const keys = fresh.map((question) => `${turnId}:${question.callId}:${question.index}`).sort();
        enqueue("question", keys, { ...snapshot, questions: fresh });
        for (const key of keys) seen.add(key);
        subscription.seenQuestions = [...seen];
      }
      const attention = snapshot.flags?.length ? canonical({ flags: [...snapshot.flags].sort(), detail: snapshot.attention ?? null }) : "";
      if (attention && attention !== subscription.lastAttention) subscription.attentionEpisode = (subscription.attentionEpisode ?? 0) + 1;
      subscription.lastAttention = attention;
      if (inProgress && attention && !questions.length) enqueue("attention", { attention, episode: subscription.attentionEpisode }, snapshot);
      const hasTurn = snapshot.turnId || snapshot.latestTurn?.id || snapshot.latestMessage || subscription.generation > 0;
      if (endedTurnStatuses.has(snapshot.turnStatus) && hasTurn)
        enqueue("turnEnded", { status: snapshot.turnStatus, fallback: snapshot.turnId ? null : snapshot.latestMessage?.text ?? null }, snapshot);
      subscription.updatedAt = now;
      return added;
    });
  }

  enqueueSnapshot(threadId, snapshot, options) {
    const result = [];
    for (const subscription of this.list()) if (subscription.threadId === threadId) result.push(...this.observe(subscription.id, snapshot, options));
    return result;
  }

  pollFailed(subscriptionId, error, { now = Date.now(), retryMs = 2_000 } = {}) {
    return this.transaction((state) => {
      const subscription = state.subscriptions[subscriptionId];
      if (!subscription) return null;
      subscription.lastPollAt = now; subscription.lastError = String(error?.message ?? error);
      subscription.pollFailures = (subscription.pollFailures ?? 0) + 1;
      subscription.nextPollAt = now + Math.min(60_000, retryMs * 2 ** Math.min(subscription.pollFailures - 1, 5));
      return subscription;
    });
  }

  recoverDispatches({ ownerId, now = Date.now() } = {}) {
    return this.transaction((state) => {
      const recovered = [];
      for (const event of Object.values(state.events)) if (event.phase === "dispatching" && event.ownerId !== ownerId && !alive(event.ownerPid)) {
        event.phase = "uncertain"; event.lastError = "Dispatcher exited during delivery; inspect the host before explicit retry"; event.uncertainAt = now; recovered.push(event);
      }
      return recovered;
    });
  }

  claimNext({ ownerId, now = Date.now() } = {}) {
    if (!ownerId) throw new Error("ownerId is required");
    return this.transaction((state) => {
      const events = Object.values(state.events).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const occupied = new Set(events.filter((event) => activePhases.has(event.phase)).map((event) => supervisorKey(event.supervisor)));
      const event = events.find((item) => item.phase === "pending" && item.nextAttemptAt <= now && state.subscriptions[item.subscriptionId]?.enabled && !occupied.has(supervisorKey(item.supervisor)));
      if (!event) return null;
      event.phase = "dispatching"; event.ownerId = ownerId; event.ownerPid = process.pid; event.dispatchStartedAt = now; event.attempts++;
      return { subscription: state.subscriptions[event.subscriptionId], event };
    });
  }

  finishDelivery(eventId, result = {}, { ownerId, now = Date.now(), retryMs = 2_000 } = {}) {
    return this.transaction((state) => {
      const event = state.events[eventId];
      if (!event || event.phase === "acknowledged") return event ?? null;
      if (event.phase !== "dispatching" || (ownerId && event.ownerId !== ownerId)) throw new Error("Watch delivery lease no longer belongs to this dispatcher");
      if (result.delivered === true) {
        event.phase = "delivered"; event.deliveredAt = now; event.delivery = clone(result);
        delete event.lastError;
      } else if (result.delivery === "notSent" || (result.delivered === false && result.retryable === true)) {
        event.phase = "pending"; event.lastError = String(result.error ?? "Host was not available");
        event.nextAttemptAt = now + Math.min(60_000, retryMs * 2 ** Math.min(event.attempts - 1, 5));
      } else {
        event.phase = "uncertain"; event.uncertainAt = now; event.lastError = String(result.error ?? "Host delivery outcome is uncertain; inspect it before explicit retry");
      }
      return event;
    });
  }
}
