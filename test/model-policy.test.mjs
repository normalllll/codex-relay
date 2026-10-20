import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { inspectModelPolicy, assertStandardPolicy } from "../model-policy.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-model-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const codexDirectory = path.join(directory, "codex");
  fs.mkdirSync(codexDirectory);
  const config = (text) => fs.writeFileSync(path.join(codexDirectory, "config.toml"), text);
  const rollout = (lines) => {
    const folder = path.join(codexDirectory, "sessions", "2026", "10", "20");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "rollout-timestamp-thread-1.jsonl"), lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
  };
  return { directory, codexDirectory, config, rollout };
}

test("new threads require an explicit standard policy without exposing other settings", async (t) => {
  const f = fixture(t);
  assert.equal((await inspectModelPolicy(f)).ok, false);
  f.config('service_tier = "default" # Explicit Standard\napi_key = "private-value"\n[features]\nfast_mode = true\n');
  const result = await inspectModelPolicy(f);
  assert.equal(result.ok, true);
  assert.equal(result.scope, "newThreadConfiguration");
  assert.equal(result.servedTierVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /private-value|api_key/);
  assertStandardPolicy(result);
});

test("accelerated tiers and policy ambiguities fail closed", async (t) => {
  const f = fixture(t);
  for (const text of ['service_tier = "priority"', 'service_tier = "fast"', 'service_tier = "ultrafast"',
    'service_tier = "default"\nservice_tier = "default"',
    'service_tier = "default"\n[profiles.work]\nservice_tier = "default"',
    'service_tier = "auto"', '"service_tier" = "default"', 'service_tier = "default"\nsettings = { service_tier = "default" }']) {
    f.config(text);
    const result = await inspectModelPolicy(f);
    assert.equal(result.ok, false, text);
    assert.throws(() => assertStandardPolicy(result), { code: "STANDARD_TIER_REQUIRED", delivery: "notSent" });
  }
});

test("project policy overrides and ancestor policy conflicts are inspected", async (t) => {
  const f = fixture(t);
  f.config("service_tier = 'default'");
  const projectPath = path.join(f.directory, "project", "nested");
  const policyDir = path.join(f.directory, "project", ".codex");
  fs.mkdirSync(projectPath, { recursive: true }); fs.mkdirSync(policyDir);
  fs.writeFileSync(path.join(policyDir, "config.toml"), "service_tier = 'fast'");
  const result = await inspectModelPolicy({ ...f, projectPath });
  assert.equal(result.ok, false);
  assert.equal(result.tier, "fast");
});

test("existing sessions require session evidence rather than global Standard defaults", async (t) => {
  const f = fixture(t); f.config('service_tier = "default"');
  const unknown = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { id: "thread-1" } }) });
  assert.equal(unknown.ok, false);
  const fast = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "priority" } }) });
  assert.equal(fast.tier, "fast");
  const standard = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "default" } }) });
  assert.equal(standard.ok, true);
  f.config('service_tier = "fast"');
  const savedStandard = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "default" } }) });
  assert.equal(savedStandard.ok, true, "The selected session's explicit Standard setting overrides new-session defaults");
});

test("only explicit latest turn metadata establishes the current session policy", async (t) => {
  const f = fixture(t);
  const result = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({
    thread: { service_tier: "default" }, turns: [{ serviceTier: "fast" }, { serviceTier: "default" }],
  }) });
  assert.equal(result.ok, false);
  assert.equal(result.tier, "fast");
});

test("bounded rollout inspection uses the latest context and rejects stale historical defaults", async (t) => {
  const f = fixture(t);
  const context = (tier) => ({ type: "turn_context", payload: { thread_id: "thread-1", ...(tier ? { service_tier: tier } : {}) } });
  f.rollout([context("fast"), "x".repeat(3 * 1024 * 1024), context("default")]);
  assert.equal((await inspectModelPolicy({ ...f, threadId: "thread-1" })).ok, true);
  f.rollout([context("default"), context(null)]);
  assert.equal((await inspectModelPolicy({ ...f, threadId: "thread-1" })).ok, false);
  f.rollout([context("default"), '{"type":"turn_context","payload":']);
  assert.equal((await inspectModelPolicy({ ...f, threadId: "thread-1" })).ok, false);
});

test("unrelated transcript text cannot impersonate model settings", async (t) => {
  const f = fixture(t);
  f.rollout([{ type: "response_item", payload: { service_tier: "default" } }]);
  assert.equal((await inspectModelPolicy({ ...f, threadId: "thread-1" })).ok, false);
  const metadata = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ turns: [{ items: [{ serviceTier: "default" }] }] }) });
  assert.equal(metadata.ok, false);
});
