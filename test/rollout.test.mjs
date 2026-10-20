import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRolloutBackward } from "../codex-client.mjs";

function file(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-rollout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(result, text);
  return result;
}

test("the session log is read newest line first and stops as soon as the visitor is satisfied", (t) => {
  const log = file(t, "first\nsecond\nthird\n");
  const seen = [];
  assert.equal(scanRolloutBackward(log, (line) => { seen.push(line); return line === "second"; }), true);
  assert.deepEqual(seen, ["third", "second"]);
});

test("a first line without a preceding newline and a final line without a trailing newline are both read", (t) => {
  const seen = [];
  assert.equal(scanRolloutBackward(file(t, "only-first\nlast-unterminated"), (line) => { seen.push(line); return false; }), true);
  assert.deepEqual(seen, ["last-unterminated", "only-first"]);
});

test("multi-byte lines survive chunk boundaries and the byte limit discards a cut-off line", (t) => {
  const long = "界".repeat(400_000); // 1.2 MB of three-byte characters spans read chunks
  const log = file(t, `head\n${long}\ntail\n`);
  const seen = [];
  assert.equal(scanRolloutBackward(log, (line) => { seen.push(line); return false; }), true);
  assert.deepEqual(seen, ["tail", long, "head"]);
  const limited = [];
  assert.equal(scanRolloutBackward(log, (line) => { limited.push(line); return false; }, 1024), false);
  assert.deepEqual(limited, ["tail"], "only complete lines within the limit are visited");
});
