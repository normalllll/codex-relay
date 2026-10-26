import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WatchStore } from "../src/watch/watch-store.mjs";
import { WatchEngine } from "../src/watch/watch-engine.mjs";

function fixture(t, options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-watch-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith("codex-relay-watch-"));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const store = new WatchStore(home, options);
  const subscription = store.subscribe({ threadId: "target", supervisor: { host: "codex", threadId: "supervisor" } });
  return { home, store, subscription };
}

const question = (callId = "call_a", turnId = "turn_a", index = 0) => ({ threadId: "target", turnId, turnStatus: "inProgress", questions: [{ callId, index, question: "Which option?" }] });
const completed = (turnId = "turn_a") => ({ threadId: "target", turnId, turnStatus: "completed", latestMessage: { text: "Done" } });

test("verified target bindings cannot be replaced, erased, or reduced to incomplete metadata", (t) => {
  const { store, home, subscription } = fixture(t);
  const target = { threadId: "target", hostId: "local", title: "Original", projectId: "project", projectPath: home, cwd: home };
  store.subscribe({ ...subscription, target });
  store.subscribe({ ...subscription, target: { ...target, title: "Renamed" } });
  assert.equal(store.get(subscription.id).target.title, "Renamed");
  for (const patch of [{ cwd: path.join(home, "another") }, { projectId: "other" }, { threadId: "other" }])
    assert.throws(() => store.subscribe({ ...subscription, target: { ...target, ...patch } }), /binding/);
  for (const invalid of [null, { threadId: "target", hostId: "local" }])
    assert.throws(() => store.subscribe({ ...subscription, target: invalid }), /verified target binding/);
  store.subscribe(subscription);
  assert.equal(store.get(subscription.id).target.cwd, home);
});

test("binding an old subscription preserves watch history and cannot reactivate a completed task", (t) => {
  const { store, home, subscription } = fixture(t);
  const [event] = store.observe(subscription.id, question());
  const before = store.get(subscription.id);
  const target = { threadId: subscription.threadId, hostId: "local", title: "Target", projectId: "project", projectPath: home, cwd: home };
  const bound = store.bindTarget(subscription.id, target);
  assert.deepEqual({ ...bound, target: undefined }, { ...before, target: undefined });
  assert.equal(store.events()[0].id, event.id);
  store.ack({ eventId: event.id, action: "complete" });
  assert.throws(() => store.bindTarget(subscription.id, target), /inactive/);
  store.subscribe({ id: subscription.id, threadId: subscription.threadId, supervisor: subscription.supervisor, target });
  assert.equal(store.get(subscription.id).enabled, false);
});

test("questions are durably deduplicated across engine restarts and rearmed after acknowledgment", async (t) => {
  const { home, store } = fixture(t);
  const delivered = [];
  let snapshot = question();
  const options = { store, status: async () => snapshot, wake: async (_, event) => { delivered.push(event.id); return { delivered: true }; } };
  await new WatchEngine(options).tick();
  assert.equal(delivered.length, 1);
  const restored = new WatchStore(home);
  await new WatchEngine({ ...options, store: restored }).tick();
  assert.equal(delivered.length, 1);
  restored.ack({ eventId: delivered[0], action: "rearm" });
  await new WatchEngine({ ...options, store: restored }).tick();
  assert.equal(delivered.length, 1, "Acknowledging does not repeat the same question");
  snapshot = question("call_b");
  await new WatchEngine({ ...options, store: restored }).tick();
  assert.equal(delivered.length, 2);
  restored.ack({ eventId: delivered[1], action: "complete" });
  snapshot = question("call_c");
  await new WatchEngine({ ...options, store: restored }).tick();
  assert.equal(delivered.length, 2);
  assert.equal(restored.list()[0].enabled, false);
});

test("completion identities include turn IDs even when final text is identical", async (t) => {
  const { store } = fixture(t);
  const delivered = [];
  let snapshot = completed();
  const engine = new WatchEngine({ store, status: async () => snapshot, wake: async (_, event) => { delivered.push(event); return { delivered: true }; } });
  await engine.tick();
  store.ack({ eventId: delivered[0].id, action: "rearm" });
  await engine.tick();
  assert.equal(delivered.length, 1);
  snapshot = completed("turn_b"); await engine.tick();
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0].id, delivered[1].id);
  assert.equal(delivered[1].type, "turnEnded");
});

test("an empty thread does not produce completion, and partial question sets do not create new events", async (t) => {
  const { store, subscription } = fixture(t);
  assert.deepEqual(store.observe(subscription.id, { threadStatus: "idle", turnStatus: null }), []);
  assert.deepEqual(store.observe(subscription.id, { turnId: "queued", turnStatus: "pending" }), []);
  const snapshot = question();
  snapshot.questions.push({ callId: "call_a", index: 1, question: "Second option?" });
  const initial = store.observe(subscription.id, snapshot);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].payload.questions.length, 2);
  snapshot.questions.shift();
  assert.deepEqual(store.observe(subscription.id, snapshot), []);
  snapshot.questions.push({ callId: "call_a", index: 2, question: "Third option?" });
  const later = store.observe(subscription.id, snapshot);
  assert.equal(later.length, 1);
  assert.deepEqual(later[0].payload.questions.map((item) => item.index), [2]);
});

test("attention is stable within an episode and can recur after flags clear", async (t) => {
  const { store, subscription } = fixture(t);
  const snapshot = { turnId: "turn_a", turnStatus: "inProgress", flags: ["approval"], attention: { command: "check" } };
  const first = store.observe(subscription.id, snapshot)[0];
  assert.equal(first.type, "attention");
  assert.deepEqual(store.observe(subscription.id, snapshot), []);
  store.ack({ eventId: first.id, action: "rearm" });
  store.observe(subscription.id, { ...snapshot, flags: [] });
  const second = store.observe(subscription.id, snapshot)[0];
  assert.notEqual(first.id, second.id);
});

test("definitely unsent wake failures retry with backoff and survive a restart", async (t) => {
  const { store, home } = fixture(t);
  let now = 10_000;
  let attempts = 0;
  const options = { store, now: () => now, pollMs: 100, status: async () => question(), wake: async () => { attempts++; return attempts === 1 ? { delivery: "notSent", error: "Host offline" } : { delivered: true }; } };
  const first = await new WatchEngine(options).tick();
  assert.equal(first.retrying, 1);
  assert.equal(attempts, 1);
  const next = new WatchEngine({ ...options, store: new WatchStore(home) });
  await next.tick(); assert.equal(attempts, 1);
  now += 100;
  await next.tick(); assert.equal(attempts, 2);
  assert.equal(store.events()[0].phase, "delivered");
});

test("ambiguous wake delivery is not retried without explicit authorization", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const engine = new WatchEngine({ store, status: async () => question(), wake: async () => { calls++; if (calls === 1) throw new Error("Connection closed after send"); return { delivered: true }; } });
  assert.equal((await engine.tick()).uncertain, 1);
  const event = store.events()[0];
  assert.equal(event.phase, "uncertain");
  await engine.tick(); assert.equal(calls, 1);
  store.ack({ eventId: event.id, action: "retry" });
  await engine.tick(); assert.equal(calls, 2);
  assert.equal(store.events()[0].phase, "delivered");
});

test("a process crash during dispatch is recovered as uncertain, not blindly resent", (t) => {
  const { store } = fixture(t);
  store.observe(store.list()[0].id, question());
  const claimed = store.claimNext({ ownerId: "old-owner" });
  store.transaction((state) => { state.events[claimed.event.id].ownerPid = 999_999_999; });
  const recovered = store.recoverDispatches({ ownerId: "new-owner" });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].phase, "uncertain");
  assert.equal(store.claimNext({ ownerId: "new-owner" }), null);
});

test("one supervisor receives only one in-flight event across subscriptions", async (t) => {
  const { store } = fixture(t);
  store.subscribe({ threadId: "other", supervisor: { host: "codex", threadId: "supervisor" } });
  let calls = 0;
  const engine = new WatchEngine({ store, status: async () => completed(), wake: async () => { calls++; return { delivered: true }; } });
  await engine.tick(); assert.equal(calls, 1);
  assert.equal(store.events().filter((item) => item.phase === "pending").length, 1);
  const delivered = store.events().find((item) => item.phase === "delivered");
  store.ack({ eventId: delivered.id, action: "rearm" });
  await engine.tick(); assert.equal(calls, 2);
});

test("removing a subscription cancels its outbox, while malformed state is preserved", (t) => {
  const { store, subscription } = fixture(t);
  store.observe(subscription.id, question());
  assert.equal(store.remove(subscription.id).removed, true);
  assert.equal(store.events().length, 0);
  assert.equal(store.events({ includeAcknowledged: true })[0].reason, "subscriptionRemoved");
  fs.writeFileSync(store.file, "not-json");
  assert.throws(() => store.list(), /preserved/);
  assert.equal(fs.readFileSync(store.file, "utf8"), "not-json");
});

test("stale process locks recover, while a live owner is not displaced", (t) => {
  const { store } = fixture(t, { lockTimeoutMs: 30 });
  fs.writeFileSync(store.lock, JSON.stringify({ pid: 999_999_999, nonce: "dead" }));
  assert.equal(store.list().length, 1);
  const lock = JSON.stringify({ pid: process.pid, nonce: "alive" });
  fs.writeFileSync(store.lock, lock);
  assert.throws(() => store.list(), /busy/);
  assert.equal(fs.readFileSync(store.lock, "utf8"), lock);
  fs.unlinkSync(store.lock);
});

test("separate Node/Bun processes serialize updates without losing subscriptions", async (t) => {
  const { home, store } = fixture(t);
  const module = new URL("../src/watch/watch-store.mjs", import.meta.url).href;
  const children = Array.from({ length: 3 }, (_, worker) => {
    const script = `import {WatchStore} from ${JSON.stringify(module)};const s=new WatchStore(${JSON.stringify(home)});for(let n=0;n<8;n++)s.subscribe({id:'worker-${worker}-'+n,threadId:'target-${worker}-'+n,supervisor:{host:'claude',sessionId:'session-${worker}'}});`;
    return spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  });
  const results = await Promise.all(children.map(async (child) => { let stderr = ""; child.stderr.on("data", (data) => { stderr += data; }); const [code] = await once(child, "exit"); return { code, stderr }; }));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(store.list().length, 25);
});

test("a live state owner is never displaced or sent through reclaim-guard contention", (t) => {
  const { store } = fixture(t, { lockTimeoutMs: 30 });
  const lock = JSON.stringify({ pid: process.pid, nonce: "active-owner" });
  fs.writeFileSync(store.lock, lock);
  const originalOpen = fs.openSync;
  fs.openSync = function (file, ...args) {
    if (file === store.reclaimLock) throw new Error("A live owner must not contend for the reclaim guard");
    return originalOpen.call(this, file, ...args);
  };
  try {
    assert.throws(() => store.list(), /busy/);
    assert.equal(fs.readFileSync(store.lock, "utf8"), lock);
  } finally { fs.openSync = originalOpen; fs.unlinkSync(store.lock); }
});

test("Windows sharing violations retry without stealing locks or hiding permanent access denial", { skip: process.platform !== "win32" }, (t) => {
  const { store } = fixture(t, { lockTimeoutMs: 60 });
  fs.writeFileSync(store.lock, JSON.stringify({ pid: 999_999_999, nonce: "dead-owner" }));
  const originalOpen = fs.openSync;
  let collisions = 0;
  fs.openSync = function (file, ...args) {
    if (file === store.reclaimLock && collisions++ < 2) throw Object.assign(new Error("Temporary sharing violation"), { code: "EPERM" });
    return originalOpen.call(this, file, ...args);
  };
  try {
    assert.equal(store.list().length, 1);
    assert.ok(collisions >= 3);
  } finally { fs.openSync = originalOpen; }
  fs.openSync = function (file, ...args) {
    if (file === store.lock) throw Object.assign(new Error("Persistent access denial"), { code: "EACCES" });
    return originalOpen.call(this, file, ...args);
  };
  try { assert.throws(() => store.list(), { code: "EACCES" }); }
  finally { fs.openSync = originalOpen; }
});

test("read-only inspection and empty claims do not rewrite durable state", (t) => {
  const { store } = fixture(t);
  const before = fs.readFileSync(store.file, "utf8");
  store.list(); store.events(); store.claimNext({ ownerId: "idle" }); store.recoverDispatches({ ownerId: "idle" });
  assert.equal(fs.readFileSync(store.file, "utf8"), before);
});

test("successful polling resets error backoff and delivered events can be explicitly reconciled", (t) => {
  const { store, subscription } = fixture(t);
  store.pollFailed(subscription.id, new Error("offline"), { now: 100, retryMs: 50 });
  assert.equal(store.list()[0].pollFailures, 1);
  store.observe(subscription.id, question(), { now: 200 });
  assert.equal(store.list()[0].pollFailures, 0);
  const { event } = store.claimNext({ ownerId: "dispatcher", now: 200 });
  store.finishDelivery(event.id, { delivered: true }, { ownerId: "dispatcher", now: 201 });
  store.ack({ eventId: event.id, action: "retry", now: 202 });
  assert.equal(store.events()[0].phase, "pending");
});

test("run keeps polling other subscriptions while a slow host is processing an event", async (t) => {
  const { store } = fixture(t);
  store.subscribe({ threadId: "other", supervisor: { host: "claude", sessionId: "claude-session" } });
  const polled = new Map();
  const started = [];
  const stop = new AbortController();
  const engine = new WatchEngine({
    store, pollMs: 10,
    status: async (threadId) => { polled.set(threadId, (polled.get(threadId) ?? 0) + 1); return completed(); },
    wake: async (_, event, { signal }) => {
      started.push(event.threadId);
      if (event.threadId === "other") return { delivered: true };
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ error: "Stopped while host processing" }), { once: true }));
    },
  });
  const running = engine.run({ signal: stop.signal });
  const deadline = Date.now() + 2_000;
  while ((polled.get("other") ?? 0) < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort(); await running;
  assert.ok((polled.get("other") ?? 0) >= 3);
  assert.deepEqual(new Set(started), new Set(["target", "other"]));
  assert.equal(store.events().find((event) => event.threadId === "target").phase, "uncertain");
  assert.equal(store.events().find((event) => event.threadId === "other").phase, "delivered");
});
