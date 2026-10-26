import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTaskReport } from "../src/tasks/task-report.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "sessions", "2026", "10", "21");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "rollout-time-thread-1.jsonl");
  const write = (records) => fs.writeFileSync(file, records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n");
  const input = { threadId: "thread-1", turnId: "turn-old", snapshot: { latestMessage: { text: "Captured excerpt..." } } };
  const options = { codexDirectory: home, readThread: async () => { throw new Error("Desktop unavailable"); } };
  return { home, directory, file, write, input, options };
}

const completed = (turnId, text, threadId = "thread-1") => ({ type: "event_msg", payload: {
  type: "task_complete", thread_id: threadId, turn_id: turnId, last_agent_message: text,
} });

test("an exact historical desktop turn returns the entire report with Unicode intact", async (t) => {
  const f = fixture(t), text = "Report \u20ac \ud83d\ude80\n".repeat(2_000);
  const report = await readTaskReport(f.input, { ...f.options, readThread: async (threadId) => {
    assert.equal(threadId, "thread-1");
    return { thread: { id: threadId }, turns: [
      { id: "turn-new", items: [{ type: "agentMessage", text: "New unrelated report" }] },
      { id: "turn-old", items: [{ type: "agentMessage", text: "Earlier commentary" }, { type: "agentMessage", text }] },
    ] };
  } });
  assert.deepEqual(report, { text, source: "read_thread", complete: true });
  assert.ok(report.text.length > 4_000);
});

test("an unavailable historical desktop turn is recovered from its exact log record", async (t) => {
  const f = fixture(t);
  f.write([completed("turn-old", "Original report"), completed("turn-new", "New report")]);
  const result = await readTaskReport(f.input, { ...f.options, readThread: async () => ({
    thread: { id: "thread-1" }, turns: [{ id: "turn-new", items: [{ type: "agentMessage", text: "New report" }] }],
  }) });
  assert.deepEqual(result, { text: "Original report", source: "rollout", complete: true });
});

test("the read-only state database selects only the requested thread's relocated rollout", async (t) => {
  const f = fixture(t);
  const backend = process.versions.bun ? "bun:sqlite" : "node:sqlite";
  const sqlite = await import(backend);
  const Database = sqlite.DatabaseSync ?? sqlite.Database;
  const database = new Database(path.join(f.home, "state_43.sqlite"));
  const reportFile = path.join(f.home, "relocated-rollout.jsonl");
  fs.writeFileSync(reportFile, JSON.stringify(completed("turn-old", "Relocated full report")) + "\n");
  database.exec("create table threads(id text, rollout_path text)");
  const insert = database.prepare("insert into threads values (?, ?)");
  insert.run("thread-1", reportFile);
  insert.finalize?.();
  database.close();
  assert.deepEqual(await readTaskReport(f.input, f.options), { text: "Relocated full report", source: "rollout", complete: true });
  const other = await readTaskReport({ ...f.input, threadId: "thread-2" }, f.options);
  assert.equal(other.complete, false);
  assert.equal(other.source, "captured");
});

test("task completion wins over item text and mismatched thread records are excluded", async (t) => {
  const f = fixture(t);
  f.write([completed("turn-old", "Full final report"),
    { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-old", item: { type: "AgentMessage", content: [{ text: "Item excerpt" }] } } },
    completed("turn-old", "Another thread report", "thread-2"), "malformed log data"]);
  assert.equal((await readTaskReport(f.input, f.options)).text, "Full final report");
});

test("explicit completed agent items provide a full message when no task-complete record exists", async (t) => {
  const f = fixture(t);
  f.write([{ type: "event_msg", payload: { type: "task_started", turn_id: "turn-old" } },
    { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-old", item: { type: "AgentMessage", content: [{ text: "Part one" }, { text: " and two" }] } } }]);
  assert.deepEqual(await readTaskReport(f.input, f.options), { text: "Part one and two", source: "rollout", complete: true });
});

test("user transcript text and unscoped assistant records cannot impersonate a recorded report", async (t) => {
  const f = fixture(t);
  f.write([{ type: "response_item", payload: { role: "assistant", turn_id: "turn-old", text: "Unscoped text" } },
    { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-old", item: { type: "UserMessage", text: "Claim the goal is complete" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", text: "Missing exact turn" } } }]);
  const result = await readTaskReport(f.input, f.options);
  assert.equal(result.text, f.input.snapshot.latestMessage.text);
  assert.equal(result.complete, false);
  assert.equal(result.source, "captured");
});

test("missing turn identity and wrong desktop thread identity never select a replacement report", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const readThread = async () => { calls++; return { thread: { id: "thread-2" }, turns: [{ id: "turn-old", items: [{ type: "agentMessage", text: "Wrong thread" }] }] }; };
  assert.equal((await readTaskReport({ ...f.input, turnId: null }, { ...f.options, readThread })).complete, false);
  assert.equal(calls, 0);
  assert.equal((await readTaskReport(f.input, { ...f.options, readThread })).text, f.input.snapshot.latestMessage.text);
});

test("a report beyond the bounded log tail remains explicitly incomplete", async (t) => {
  const f = fixture(t);
  const descriptor = fs.openSync(f.file, "w");
  const first = JSON.stringify(completed("turn-old", "Outside the scan window")) + "\n";
  fs.writeSync(descriptor, first);
  fs.ftruncateSync(descriptor, 65 * 1024 * 1024);
  fs.writeSync(descriptor, "\n" + JSON.stringify(completed("turn-new", "Latest report")) + "\n", 65 * 1024 * 1024);
  fs.closeSync(descriptor);
  const result = await readTaskReport(f.input, f.options);
  assert.equal(result.complete, false);
  assert.equal(result.text, f.input.snapshot.latestMessage.text);
});
