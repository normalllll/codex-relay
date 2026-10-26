import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { inspectModelPolicy, assertStandardPolicy } from "../src/tasks/model-policy.mjs";

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
  return { directory, codexDirectory, config, rollout, readSessionPolicy: async () => ({ threadId: "thread-1", available: false }) };
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
  assert.equal(unknown.reasonCode, "SESSION_TIER_UNAVAILABLE");
  assert.match(unknown.nextAction, /preserve its requestId/);
  assert.match(unknown.nextAction, /Do not repeatedly toggle/);
  assert.doesNotMatch(unknown.nextAction, /Select Standard|configure service_tier/);
  const fast = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "priority" } }) });
  assert.equal(fast.tier, "fast");
  assert.equal(fast.reasonCode, "SESSION_TIER_ACCELERATED");
  assert.match(fast.nextAction, /Select Standard for this Codex session/);
  const standard = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "default" } }) });
  assert.equal(standard.ok, true);
  f.config('service_tier = "fast"');
  const savedStandard = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "default" } }) });
  assert.equal(savedStandard.ok, true, "The selected session's explicit Standard setting overrides new-session defaults");
});

test("unavailable and unrecognized session tiers remain blocked with distinct diagnostics", async (t) => {
  const f = fixture(t);
  for (const metadata of [{ thread: { serviceTier: null } }, { thread: { id: "thread-1" } }]) {
    const unavailable = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => metadata });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.tier, "unknown");
    assert.equal(unavailable.reasonCode, "SESSION_TIER_UNAVAILABLE");
  }
  const unrecognized = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "auto" } }) });
  assert.equal(unrecognized.ok, false);
  assert.equal(unrecognized.reasonCode, "SESSION_TIER_UNRECOGNIZED");
  assert.throws(() => assertStandardPolicy(unrecognized), { code: "STANDARD_TIER_REQUIRED", delivery: "notSent" });
});

test("live session settings establish Standard without using defaults or stale rollout turns", async (t) => {
  const f = fixture(t); f.config('service_tier = "fast"');
  f.rollout([{ type: "turn_context", payload: { service_tier: "fast" } }]);
  let selected;
  const policy = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { id: "thread-1" } }),
    readSessionPolicy: async (threadId) => { selected = threadId; return { threadId, available: true, serviceTier: "default", protocolVersion: 11, revision: 7, transcript: "private-content" }; } });
  assert.equal(selected, "thread-1");
  assert.equal(policy.ok, true);
  assert.equal(policy.tier, "standard");
  assert.equal(policy.servedTierVerified, false);
  assert.deepEqual(policy.evidence, [{ source: "desktopSessionSettings", kind: "session", tiers: ["default"], protocolVersion: 11, revision: 7 }]);
  assert.doesNotMatch(JSON.stringify(policy), /private-content|transcript/);
});

test("live Fast, unknown and conflicting session evidence cannot be overridden by Standard metadata", async (t) => {
  const f = fixture(t); f.config('service_tier = "default"');
  for (const [live, metadata, expected] of [["fast", "default", "fast"], ["default", "priority", "fast"], [null, "default", "unknown"], ["future-tier", "default", "unknown"]]) {
    const result = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: metadata } }),
      readSessionPolicy: async (threadId) => ({ threadId, available: true, serviceTier: live }) });
    assert.equal(result.ok, false);
    assert.equal(result.tier, expected);
  }
});

test("unavailable desktop settings preserve other explicit session evidence and bounded diagnostics", async (t) => {
  const f = fixture(t);
  const result = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "default" } }),
    readSessionPolicy: async () => { throw new Error("unavailable ".repeat(100)); } });
  assert.equal(result.ok, true);
  assert.equal(result.evidence[0].status, "unavailable");
  assert.ok(result.evidence[0].reason.length <= 300);
  const wrong = await inspectModelPolicy({ ...f, threadId: "thread-1",
    readSessionPolicy: async () => ({ threadId: "other-thread", available: true, serviceTier: "default" }) });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reasonCode, "SESSION_TIER_UNAVAILABLE");
});

test("a session applying new settings cannot fall back to historical Standard evidence", async (t) => {
  const f = fixture(t);
  f.rollout([{ type: "turn_context", payload: { service_tier: "default" } }]);
  const result = await inspectModelPolicy({ ...f, threadId: "thread-1", readThread: async () => ({ thread: { serviceTier: "default" } }),
    readSessionPolicy: async (threadId) => ({ threadId, available: false, reasonCode: "SESSION_SETTINGS_UNSETTLED" }) });
  assert.equal(result.ok, false);
  assert.equal(result.tier, "unknown");
  assert.equal(result.reasonCode, "SESSION_TIER_UNAVAILABLE");
  assert.match(result.nextAction, /finishes applying its settings/);
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
