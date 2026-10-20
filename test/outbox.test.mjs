import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReplyOutbox } from "../outbox.mjs";

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

test("concurrent duplicate request IDs cannot execute the same send twice", async (t) => {
  const { outbox } = fixture(t);
  let unblock, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const pending = outbox.execute("concurrent", {}, (tx) => tx.stage("instruction", () => new Promise((resolve) => { unblock = resolve; entered(); })));
  await ready;
  await assert.rejects(outbox.execute("concurrent", {}, () => { throw new Error("Should never run"); }), /already being processed/);
  unblock({ sent: true }); await pending;
});
