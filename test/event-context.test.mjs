import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WatchStore } from "../watch-store.mjs";
import { createEventReader } from "../event-context.mjs";

function fixture(t, { goal, snapshot } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-event-context-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith("codex-relay-event-context-"));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const store = new WatchStore(home);
  const subscription = store.subscribe({ threadId: "execution-1", supervisor: { host: "codex", threadId: "supervisor-1" },
    goal: goal ?? { task: "Fix the regression", doneWhen: "The affected checks pass" }, policy: { noFast: true } });
  const saved = snapshot ?? { threadId: "execution-1", turnId: "original-turn", threadStatus: "idle", turnStatus: "completed", latestMessage: { phase: "final_answer", text: "Saved event preview" } };
  const [event] = store.observe(subscription.id, saved);
  assert.ok(event);
  return { home, store, subscription, event, saved, state: () => fs.readFileSync(store.file, "utf8") };
}

test("event context is compact by default and never reads the full task report", async (t) => {
  const f = fixture(t), before = f.state();
  let statusCalls = 0;
  const reader = createEventReader({ store: f.store,
    readStatus: async (threadId) => {
      statusCalls++; assert.equal(threadId, f.event.threadId);
      return { ...f.saved, latestMessage: { phase: "final_answer", text: "a".repeat(399) + "😀" + "full report body" } };
    }, readReport: () => assert.fail("A compact context must not fetch the full report") });
  const value = await reader.context({ eventId: f.event.id });
  assert.equal(statusCalls, 1);
  assert.equal(value.event.eventId, f.event.id);
  assert.equal(value.event.turnId, "original-turn");
  assert.equal(value.currentAvailable, true);
  assert.equal(value.stale, false);
  assert.equal(value.current.latestMessage.text, "a".repeat(399));
  assert.equal(value.current.latestMessage.truncated, true);
  assert.deepEqual(value.goal, f.subscription.goal);
  assert.deepEqual(value.policy, { noFast: true });
  assert.deepEqual(value.report, { tool: "codex_event_report", eventId: f.event.id });
  assert.equal(value.dataTrust, "taskData");
  assert.equal(f.state(), before, "Reading event context must not rewrite the durable record");
});

test("long task and acceptance criteria remain available through lossless goal paging", async (t) => {
  const goal = { task: "t".repeat(999) + "😀" + "task suffix", doneWhen: "d".repeat(2200) + "acceptance suffix" };
  const f = fixture(t, { goal }), before = f.state();
  const reader = createEventReader({ store: f.store, readStatus: async () => f.saved,
    readReport: () => assert.fail("Goal pages come from the persisted subscription") });
  const value = await reader.context({ eventId: f.event.id });
  assert.equal(value.goalTruncated, true);
  assert.equal(value.goal.task, "t".repeat(999));
  assert.equal(value.goal.doneWhen.length, 2000);
  assert.deepEqual(value.goalReport, { tool: "codex_event_report", eventId: f.event.id, section: "goal" });
  let text = "", offset = 0, hash;
  do {
    const page = await reader.report({ eventId: f.event.id, section: "goal", offset, limit: 256, reportHash: hash });
    assert.equal(page.source, "subscription");
    assert.equal(page.eventId, f.event.id);
    text += page.text; offset = page.nextOffset; hash = page.reportHash;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(text), goal);
  assert.equal(f.state(), before);
});

test("acknowledged events are skipped without querying the host", async (t) => {
  const f = fixture(t);
  f.store.ack({ eventId: f.event.id, action: "rearm" });
  const before = f.state();
  const reader = createEventReader({ store: f.store, readStatus: () => assert.fail("Handled events require no host query"),
    readReport: () => assert.fail("Handled context requires no report query") });
  const value = await reader.context({ eventId: f.event.id });
  assert.equal(value.handled, true);
  assert.equal(value.action, "rearm");
  assert.equal(value.nextAction, "skip");
  assert.equal(value.event.phase, "acknowledged");
  assert.equal(value.current, undefined);
  assert.equal(f.state(), before);
});

test("acknowledgment during an in-flight status read prevents acting on its stale result", async (t) => {
  const f = fixture(t);
  const reader = createEventReader({ store: f.store, readStatus: async () => {
    f.store.ack({ eventId: f.event.id, action: "complete" });
    return f.saved;
  } });
  const value = await reader.context({ eventId: f.event.id });
  assert.equal(value.handled, true);
  assert.equal(value.action, "complete");
  assert.equal(value.nextAction, "skip");
  assert.equal(value.current, undefined);
  assert.equal(f.store.list()[0].enabled, false);
});

test("completing one event skips other pending events in its disabled subscription", async (t) => {
  const f = fixture(t);
  const [second] = f.store.observe(f.subscription.id, { ...f.saved, turnId: "second-turn" });
  f.store.ack({ eventId: f.event.id, action: "complete" });
  const before = f.state();
  const reader = createEventReader({ store: f.store, readStatus: () => assert.fail("A disabled subscription must not query the host") });
  const value = await reader.context({ eventId: second.id });
  assert.equal(value.handled, false, "Skipping disabled work must not fabricate an acknowledgment");
  assert.equal(value.subscriptionEnabled, false);
  assert.equal(value.event.phase, "pending");
  assert.equal(value.nextAction, "skip");
  assert.equal(value.current, undefined);
  assert.equal(f.state(), before);
});

test("another event completing the subscription during a status read also stops follow-up", async (t) => {
  const f = fixture(t);
  const [second] = f.store.observe(f.subscription.id, { ...f.saved, turnId: "second-turn" });
  const reader = createEventReader({ store: f.store, readStatus: async () => {
    f.store.ack({ eventId: second.id, action: "complete" });
    return f.saved;
  } });
  const value = await reader.context({ eventId: f.event.id });
  assert.equal(value.handled, false);
  assert.equal(value.subscriptionEnabled, false);
  assert.equal(value.event.phase, "pending");
  assert.equal(value.nextAction, "skip");
});

test("question context preserves exact answer keys while bounding question and attention details", async (t) => {
  const snapshot = { threadId: "execution-1", turnId: "question-turn", threadStatus: "active", turnStatus: "inProgress",
    questions: [{ callId: "call-exact", index: 2, question: "q".repeat(800) + "question suffix" }],
    latestMessage: { phase: "question", text: "m".repeat(900) }, flags: ["needsAttention"],
    attention: { type: "commandExecution", command: "c".repeat(500), files: Array.from({ length: 20 }, (_, index) => `file-${index}`) } };
  const f = fixture(t, { snapshot }), before = f.state();
  const reader = createEventReader({ store: f.store, readStatus: async () => snapshot,
    readReport: () => assert.fail("Answering a compact question does not require the full report") });
  const value = await reader.context({ eventId: f.event.id });
  assert.equal(value.event.type, "question");
  assert.equal(value.current.questions[0].callId, "call-exact");
  assert.equal(value.current.questions[0].index, 2);
  assert.equal(value.current.questions[0].question.length, 800);
  assert.equal(value.current.questions[0].truncated, true);
  assert.equal(value.current.latestMessage.text.length, 400);
  assert.equal(value.current.attention.command.length, 300);
  assert.equal(value.current.attention.files.length, 16);
  assert.equal(value.nextAction, "handle");
  assert.equal(f.state(), before);
});

test("unknown events and invalid bounds are rejected before any host query", async (t) => {
  const f = fixture(t), before = f.state();
  const fail = () => assert.fail("Invalid event requests must not reach a host reader");
  const reader = createEventReader({ store: f.store, readStatus: fail, readReport: fail });
  await assert.rejects(reader.context({ eventId: "unknown-event" }), /Unknown watch event/);
  await assert.rejects(reader.report({ eventId: "unknown-event" }), /Unknown watch event/);
  for (const previewChars of [63, 2001, 100.5]) await assert.rejects(reader.context({ eventId: f.event.id, previewChars }), /previewChars/);
  for (const limit of [255, 16001, 1000.5]) await assert.rejects(reader.report({ eventId: f.event.id, limit }), /limit/);
  for (const offset of [-1, 0.5]) await assert.rejects(reader.report({ eventId: f.event.id, offset }), /offset/);
  await assert.rejects(reader.report({ eventId: f.event.id, section: "transcript" }), /section/);
  assert.equal(f.state(), before);
});

test("advanced turns keep current state separate from the original event snapshot", async (t) => {
  const f = fixture(t), before = f.state();
  let reportArgs;
  const reader = createEventReader({ store: f.store,
    readStatus: async () => ({ ...f.saved, turnId: "newer-turn", latestMessage: { phase: "commentary", text: "New work is underway" } }),
    readReport: async (args) => { reportArgs = args; return { text: "Original turn report", source: "savedTurn", complete: true }; } });
  const value = await reader.context({ eventId: f.event.id });
  assert.equal(value.stale, true);
  assert.equal(value.currentAvailable, true);
  assert.equal(value.current.turnId, "newer-turn");
  assert.equal(value.current.latestMessage.text, "New work is underway");
  assert.equal(value.eventPreview.turnId, "original-turn");
  assert.equal(value.eventPreview.latestMessage.text, "Saved event preview");
  assert.equal(value.event.turnId, "original-turn");
  const report = await reader.report({ eventId: f.event.id });
  assert.equal(report.turnId, "original-turn");
  assert.equal(report.eventId, f.event.id);
  assert.deepEqual(reportArgs, { threadId: f.event.threadId, turnId: "original-turn", snapshot: f.saved });
  assert.equal(f.state(), before);
});

test("unavailable current state and reader failures expose a saved preview with retry guidance", async (t) => {
  const f = fixture(t), before = f.state();
  for (const readStatus of [async () => ({ threadStatus: "unavailable", error: "Host unavailable" }), async () => { throw new Error("e".repeat(900)); }]) {
    const reader = createEventReader({ store: f.store, readStatus, readReport: () => assert.fail("Status failure must not fetch a report") });
    const value = await reader.context({ eventId: f.event.id });
    assert.equal(value.currentAvailable, false);
    assert.equal(value.nextAction, "retryStatus");
    assert.equal(value.eventPreview.latestMessage.text, "Saved event preview");
    assert.ok(value.current.error.length <= 600);
  }
  assert.equal(f.state(), before);
});

test("report pages reconstruct full Unicode text without splitting surrogate pairs", async (t) => {
  const f = fixture(t), before = f.state();
  const text = "a".repeat(3999) + "😀" + "b".repeat(8000) + "🦊" + "c".repeat(9000);
  const reader = createEventReader({ store: f.store, readStatus: () => assert.fail("Full report paging does not query current status"),
    readReport: async ({ threadId, turnId }) => {
      assert.equal(threadId, "execution-1"); assert.equal(turnId, "original-turn");
      return { text, source: "savedTurn", complete: true };
    } });
  const first = await reader.report({ eventId: f.event.id });
  assert.equal(first.text.length, 3999);
  assert.equal(first.nextOffset, 3999);
  const maximum = await reader.report({ eventId: f.event.id, limit: 16000 });
  assert.ok(maximum.text.length <= 16000);
  let restored = "", offset = 0, reportHash;
  do {
    const page = await reader.report({ eventId: f.event.id, offset, reportHash });
    assert.equal(page.totalChars, text.length);
    assert.equal(page.offset, offset);
    assert.equal(page.turnId, "original-turn");
    assert.equal(page.complete, true);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(page.text));
    restored += page.text; offset = page.nextOffset; reportHash = page.reportHash;
  } while (offset !== null);
  assert.equal(restored, text);
  await assert.rejects(reader.report({ eventId: f.event.id, offset: 4000 }), /Unicode character/);
  await assert.rejects(reader.report({ eventId: f.event.id, offset: text.length + 1 }), /outside the report/);
  assert.equal(f.state(), before);
});

test("report hashes detect changed text before pages can be mixed", async (t) => {
  const f = fixture(t), before = f.state();
  let text = "original ".repeat(800);
  const reader = createEventReader({ store: f.store, readReport: async () => ({ text, source: "savedTurn", complete: true }) });
  const first = await reader.report({ eventId: f.event.id });
  text = "changed ".repeat(800);
  await assert.rejects(reader.report({ eventId: f.event.id, offset: first.nextOffset, reportHash: first.reportHash }), /Report changed/);
  const restarted = await reader.report({ eventId: f.event.id });
  assert.notEqual(restarted.reportHash, first.reportHash);
  assert.equal(f.state(), before);
});

test("reader restarts retain event identity, preserve snapshots, and do not rearm acknowledged work", async (t) => {
  const f = fixture(t), initial = f.state();
  const first = createEventReader({ store: f.store, readStatus: async () => f.saved });
  assert.equal((await first.context({ eventId: f.event.id })).event.eventId, f.event.id);
  const restoredStore = new WatchStore(f.home);
  const restored = createEventReader({ store: restoredStore, readStatus: async () => f.saved,
    readReport: () => assert.fail("Snapshot paging must not invoke the task report reader") });
  const page = await restored.report({ eventId: f.event.id, section: "snapshot" });
  assert.deepEqual(JSON.parse(page.text), f.saved);
  assert.equal(page.source, "eventSnapshot");
  assert.equal(f.state(), initial);
  restoredStore.ack({ eventId: f.event.id, action: "rearm" });
  const acknowledged = f.state();
  assert.equal((await first.context({ eventId: f.event.id })).nextAction, "skip");
  assert.equal(f.state(), acknowledged);
  assert.deepEqual(restoredStore.observe(f.subscription.id, f.saved), []);
  assert.equal(restoredStore.events({ includeAcknowledged: true }).length, 1);
});
