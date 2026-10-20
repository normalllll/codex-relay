import { adaptTest, runFixture } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";

test("fixture cleanup awaits every callback in ownership order after an assertion failure", async () => {
  const order = [], failure = new Error("Assertion failed");
  await assert.rejects(runFixture((context) => {
    context.after(async () => { await Promise.resolve(); order.push("first"); });
    context.after(() => order.push("second"));
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual(order, ["first", "second"]);
});

test("fixture errors preserve both the original failure and cleanup failures", async () => {
  const failure = new Error("Original failure"), cleanupFailure = new Error("Cleanup failure");
  let lastCleanup = false;
  await assert.rejects(runFixture((context) => {
    context.after(() => { throw cleanupFailure; });
    context.after(() => { lastCleanup = true; });
    throw failure;
  }), (error) => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === cleanupFailure);
  assert.equal(lastCleanup, true);
});

test("a timed-out fixture aborts its signal and cleans up before reporting failure", async () => {
  let cleaned = false;
  await assert.rejects(runFixture((context) => {
    context.after(() => { cleaned = context.signal.aborted; });
    return new Promise(() => {});
  }, 10), /timed out/);
  assert.equal(cleaned, true);
});
