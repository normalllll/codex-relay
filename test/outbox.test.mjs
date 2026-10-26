import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ReplyOutbox } from "../src/tasks/outbox.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-outbox-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, outbox: new ReplyOutbox(home) };
}

test("a repeated MCP request reuses its receipt across process state reconstruction", async (t) => {
  const { home, outbox } = fixture(t);
  let sent = 0;
  const operation = async (tx) => ({ ...await tx.stage("instruction", async () => { sent++; return { sent: true }; }) });
  await outbox.execute("event-1:reply", { message: "Continue", threadId: "target" }, operation);
  const replayed = await new ReplyOutbox(home).execute("event-1:reply", { threadId: "target", message: "Continue" }, operation);
  assert.equal(replayed.replayed, true); assert.equal(sent, 1);
  await assert.rejects(outbox.execute("event-1:reply", { message: "Different" }, operation), /different input/);
  assert.throws(() => outbox.assertInput("event-1:reply", { message: "Continue", threadId: "another-target" }), /different input/);
  assert.equal(outbox.assertInput("event-1:reply", { message: "Continue", threadId: "target" }).result.sent, true);
});

test("partial answers-plus-message retry resumes the unsent stage without repeating answers", async (t) => {
  const { outbox } = fixture(t);
  let answers = 0, messages = 0;
  const operation = async (tx) => {
    await tx.stage("answers", async () => { answers++; return { sent: true }; });
    await tx.stage("instruction", async () => {
      if (++messages === 1) throw Object.assign(new Error("Explicitly rejected before send"), { delivery: "notSent" });
      return { sent: true };
    });
    return { sent: true };
  };
  await assert.rejects(outbox.execute("partial", {}, operation));
  await outbox.execute("partial", {}, operation);
  assert.equal(answers, 1); assert.equal(messages, 2);
});

test("ambiguous writes are durably blocked rather than resent", async (t) => {
  const { home, outbox } = fixture(t);
  let calls = 0;
  const operation = (tx) => tx.stage("instruction", async () => { calls++; throw new Error("connection closed after write"); });
  await assert.rejects(outbox.execute("uncertain", {}, operation));
  await assert.rejects(new ReplyOutbox(home).execute("uncertain", {}, operation), /uncertain/);
  assert.equal(calls, 1);
});

test("read-only target inspection can retry an interrupted stage while writes remain protected", async (t) => {
  const { outbox } = fixture(t);
  let reads = 0;
  const inspect = (transaction) => transaction.stage("target", async () => {
    if (++reads === 1) throw new Error("Inspection interrupted");
    return { threadId: "original-target" };
  }, { replaySafe: true });
  await assert.rejects(outbox.execute("inspection", {}, inspect));
  assert.equal(outbox.inspect("inspection").stages.target.phase, "uncertain");
  const result = await outbox.execute("inspection", {}, inspect);
  assert.equal(result.threadId, "original-target");
  assert.equal(reads, 2);
});

test("a process crash during target inspection does not become an uncertain message delivery", async (t) => {
  const { home, outbox } = fixture(t);
  const source = `import { ReplyOutbox } from ${JSON.stringify(new URL("../src/tasks/outbox.mjs", import.meta.url).href)};
    await new ReplyOutbox(${JSON.stringify(home)}).execute("crashed-inspection", {threadId:"original-target"},
      transaction => transaction.stage("target", () => process.exit(0)));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { windowsHide: true, encoding: "utf8", timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(outbox.inspect("crashed-inspection").stages.target.phase, "dispatching");
  const result = await outbox.execute("crashed-inspection", { threadId: "original-target" },
    (transaction) => transaction.stage("target", async () => ({ threadId: "original-target" }), { replaySafe: true }));
  assert.equal(result.threadId, "original-target");
  assert.deepEqual(Object.keys(outbox.inspect("crashed-inspection").stages), ["target"]);
});

test("concurrent duplicate request IDs cannot execute the same send twice", async (t) => {
  const { outbox } = fixture(t);
  let unblock, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const pending = outbox.execute("concurrent", {}, (tx) => tx.stage("instruction", () => new Promise((resolve) => { unblock = resolve; entered(); })));
  await ready;
  await assert.rejects(outbox.execute("concurrent", {}, () => { throw new Error("Should never run"); }), /already being processed/);
  unblock({ sent: true }); await pending;
});
