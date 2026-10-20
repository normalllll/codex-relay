import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isMissingProcess } from "../process-state.mjs";
// Import without probing the real user's pipe identity; all delivery paths are injected.
const previousPipe = process.env.CODEX_RELAY_PIPE;
process.env.CODEX_RELAY_PIPE = "host-wake-test-unused-pipe";
const { createWakeHost, runHostProcess, buildWakePrompt } = await import("../host-wake.mjs");
if (previousPipe === undefined) delete process.env.CODEX_RELAY_PIPE; else process.env.CODEX_RELAY_PIPE = previousPipe;

const event = { id: "event-1", subscriptionId: "watch-1", type: "question", snapshot: { questions: [{ callId: "call-1", index: 0, question: "Which implementation?" }] } };
const watched = { id: "watch-1", threadId: "target-thread", supervisor: { host: "codex", threadId: "supervisor-thread" } };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-host-wake-"));
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("codex-relay-host-wake-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { dir, supervisor: { host: "claude", sessionId: "session-1", mode: "resume", executable: "claude-test", cwd: dir } };
}

test("Codex wakes the existing supervisor through delegated app messaging without user input impersonation", async () => {
  const calls = [];
  const wake = createWakeHost({ callApp: async (...args) => { calls.push(args); return { sent: true }; } });
  assert.deepEqual(await wake(watched, event), { delivered: true, via: "codex-desktop", supervisorThreadId: "supervisor-thread" });
  assert.equal(calls[0][0], "send_message_to_thread");
  assert.equal(calls[0][1].threadId, "supervisor-thread");
  assert.deepEqual(JSON.parse(calls[0][1].prompt), { relayEvent: 1, eventId: "event-1", subscriptionId: "watch-1", type: "question" });
  await assert.rejects(wake({ ...watched, supervisor: { host: "codex", threadId: "target-thread" } }, event), { delivery: "notSent" });
  assert.equal(calls.length, 1);
});

test("wake envelopes exclude reports, goals and repeated instructions and pass cancellation", async () => {
  const controller = new AbortController();
  let options;
  const wake = createWakeHost({ callApp: async (_tool, _args, value) => { options = value; } });
  const currentEvent = { ...event, payload: { marker: "durable-payload" }, snapshot: { marker: "old-snapshot" } };
  const prompt = buildWakePrompt({ ...watched, goal: { task: "Large authorized task".repeat(10000), doneWhen: "Acceptance criteria".repeat(10000) } }, {
    ...currentEvent, payload: { text: "Large report".repeat(100000) },
  });
  assert.deepEqual(JSON.parse(prompt), { relayEvent: 1, eventId: "event-1", subscriptionId: "watch-1", type: "question" });
  assert.ok(prompt.length < 150);
  assert.doesNotMatch(prompt, /Large|old-snapshot|codex_watch_ack/);
  await wake(watched, currentEvent, { signal: controller.signal });
  assert.equal(options.signal, controller.signal);
  controller.abort();
  await assert.rejects(wake(watched, currentEvent, { signal: controller.signal }), { delivery: "notSent" });
});

test("uncertain Codex delivery never invokes an alternate sender", async () => {
  let attempts = 0;
  const wake = createWakeHost({ callApp: async () => { attempts++; throw new Error("app pipe disconnected before responding"); }, run: () => assert.fail("No CLI fallback is safe") });
  await assert.rejects(wake(watched, event), { delivery: "uncertain" });
  assert.equal(attempts, 1);
  const missing = createWakeHost({ callApp: async () => { throw new Error("Codex Relay is not reachable: connect ECONNREFUSED"); } });
  await assert.rejects(missing(watched, event), { delivery: "notSent" });
});

test("explicit Codex queue mode verifies CLI capability and queues the stable event without app callers", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const calls = [];
  const wake = createWakeHost({ home: f.dir, callApp: () => assert.fail("Queue mode must not depend on a loaded app caller"),
    run: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return args.includes("--help") ? { code: 0, stdout: "Usage: codex queue --thread <THREAD> --message <TEXT> --config <KEY=VALUE>", stderr: "" }
        : { code: 0, stdout: "Message queued", stderr: "" };
    } });
  const subscription = { ...watched, supervisor: { host: "codex", threadId: "supervisor-thread", mode: "queue", executable: process.execPath, cwd: f.dir } };
  assert.deepEqual(await wake(subscription, event, { signal: controller.signal }), { delivered: true, via: "codex-queue", supervisorThreadId: "supervisor-thread" });
  assert.deepEqual(calls[0].args, ["queue", "--help"]);
  assert.equal(calls[1].executable, process.execPath);
  assert.deepEqual(calls[1].args.slice(0, 4), ["queue", "--thread", "supervisor-thread", "--message"]);
  assert.equal(JSON.parse(calls[1].args[4]).eventId, "event-1");
  assert.equal(calls[1].args.length, 5, "Queueing inherits the selected session settings without per-message model overrides");
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[1].options.cwd, f.dir);
  assert.equal(calls[1].options.input, "");
  assert.ok(!calls[1].args.some((arg) => /dangerously|bypass|sandbox|approve-for-me/.test(arg)));
  await wake(subscription, event);
  assert.equal(calls.length, 3, "The unchanged executable's harmless capability check is cached");
  assert.equal(calls[1].args[4], calls[2].args[4], "The same event keeps the same receiver deduplication ID");
});

test("Codex queue rejects unsupported executables and preserves ambiguous delivery without fallback", async (t) => {
  const f = fixture(t);
  const subscription = { ...watched, supervisor: { host: "codex", threadId: "supervisor-thread", mode: "queue", executable: process.execPath } };
  let calls = 0;
  const unsupported = createWakeHost({ run: async () => { calls++; return { code: 0, stdout: "Not the Codex queue interface", stderr: "" }; } });
  await assert.rejects(unsupported({ ...subscription, supervisor: { ...subscription.supervisor, executable: "codex" } }, event), { delivery: "notSent" });
  assert.equal(calls, 0);
  await assert.rejects(unsupported(subscription, event), { delivery: "notSent" });
  assert.equal(calls, 1);
  const uncertain = createWakeHost({ home: f.dir, callApp: () => assert.fail("No sender fallback is safe"), run: async (_executable, args) => {
    if (args.includes("--help")) return { code: 0, stdout: "--thread --message --config", stderr: "" };
    throw Object.assign(new Error("Queue response lost after dispatch"), { delivery: "uncertain" });
  } });
  await assert.rejects(uncertain(subscription, event), { delivery: "uncertain" });
});

test("Claude channel requires confirmed receipt and never silently launches a second session", async () => {
  const subscription = { ...watched, supervisor: { host: "claude", sessionId: "session-1" } };
  const calls = [];
  const wake = createWakeHost({ sendChannel: async (...args) => { calls.push(args); return { accepted: true }; }, run: () => assert.fail("Channel mode cannot implicitly resume") });
  const result = await wake(subscription, event);
  assert.equal(result.via, "claude-channel");
  assert.equal(calls[0][0], "session-1");
  assert.equal(calls[0][1].id, "event-1");
  const offline = createWakeHost({ sendChannel: async () => false });
  await assert.rejects(offline(subscription, event), { delivery: "notSent" });
  const ambiguous = createWakeHost({ sendChannel: async () => ({}) });
  await assert.rejects(ambiguous(subscription, event), { delivery: "uncertain" });
});

test("unattended Claude resume uses stdin, scoped MCP and a narrow allowed-tools list", async (t) => {
  const f = fixture(t);
  let invoked;
  const wake = createWakeHost({ home: f.dir, mcpPath: path.join(f.dir, "mcp.mjs"), runtime: process.execPath,
    run: async (executable, args, options) => {
      invoked = { executable, args, options };
      const file = args[args.indexOf("--mcp-config") + 1];
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(config.mcpServers.codex_relay.command, process.execPath);
      assert.equal(config.mcpServers.codex_relay.env.CODEX_RELAY_WAKE_EVENT_ID, "event-1");
      assert.equal(config.mcpServers.codex_relay.env.CODEX_RELAY_WAKE_THREAD_ID, "target-thread");
      assert.equal(config.mcpServers.codex_relay.env.CODEX_RELAY_HOME, f.dir);
      return { code: 0, stdout: JSON.stringify({ type: "result", is_error: false, session_id: "session-1" }), stderr: "" };
    } });
  const result = await wake({ ...watched, supervisor: f.supervisor }, event);
  assert.equal(result.via, "claude-resume");
  assert.equal(invoked.executable, "claude-test");
  assert.deepEqual(invoked.args.slice(0, 7), ["--resume", "session-1", "--print", "--input-format", "text", "--output-format", "json"]);
  assert.ok(!invoked.args.some((arg) => /dangerously|bypassPermissions|permission-mode|shell/i.test(arg)));
  assert.ok(!invoked.args.includes(invoked.options.input));
  assert.ok(invoked.args.includes("--strict-mcp-config"));
  assert.equal(invoked.options.env.CLAUDE_CODE_DISABLE_FAST_MODE, "1");
  assert.equal(invoked.args[invoked.args.indexOf("--settings") + 1], '{"fastMode":false}');
  assert.equal(invoked.args[invoked.args.indexOf("--tools") + 1], "");
  assert.equal(JSON.parse(invoked.options.input).eventId, "event-1");
  const allowed = invoked.args.slice(invoked.args.indexOf("--allowedTools") + 1);
  assert.deepEqual(allowed, ["mcp__codex_relay__codex_event_context", "mcp__codex_relay__codex_event_report", "mcp__codex_relay__codex_events", "mcp__codex_relay__codex_status", "mcp__codex_relay__codex_reply", "mcp__codex_relay__codex_watch_ack", "mcp__codex_relay__codex_delivery"]);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, "wake-locks")), []);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, "wake-configs")), []);
});

test("resume serializes a shared session and releases its lease after completion", async (t) => {
  const f = fixture(t);
  let finish;
  const wake = createWakeHost({ home: f.dir, run: async () => new Promise((resolve) => { finish = resolve; }) });
  const first = wake({ ...watched, supervisor: f.supervisor }, event);
  await Promise.resolve();
  await assert.rejects(wake({ ...watched, supervisor: f.supervisor }, { ...event, id: "event-2" }), /Another Relay process/);
  finish({ code: 0, stdout: '{"type":"result","is_error":false}', stderr: "" });
  await first;
  const next = createWakeHost({ home: f.dir, run: async () => ({ code: 0, stdout: '{"type":"result","is_error":false}', stderr: "" }) });
  assert.equal((await next({ ...watched, supervisor: f.supervisor }, event)).delivered, true);
});

test("resume recovers dead-owner leases and distinguishes explicit running-session refusal", async (t) => {
  const f = fixture(t);
  const lockDir = path.join(f.dir, "wake-locks"); fs.mkdirSync(lockDir);
  const lockFile = path.join(lockDir, crypto.createHash("sha256").update("session-1").digest("hex") + ".json");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483647, token: "dead-token" }));
  const refuse = createWakeHost({ home: f.dir, run: async () => ({ code: 1, stdout: "", stderr: "This session is running in the background. Your prompt was not sent to it." }) });
  await assert.rejects(refuse({ ...watched, supervisor: f.supervisor }, event), { delivery: "notSent" });
  assert.equal(fs.existsSync(lockFile), false);
  const unknown = createWakeHost({ home: f.dir, run: async () => ({ code: 1, stdout: "", stderr: "Unexpected failure after input" }) });
  await assert.rejects(unknown({ ...watched, supervisor: f.supervisor }, event), { delivery: "uncertain" });
});

test("real process runner pipes a prompt without shell interpolation and reports failed spawn", async (t) => {
  const f = fixture(t);
  const prompt = "Use $value literally and preserve `backticks`\nSecond line";
  const script = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({input:s})));";
  const result = await runHostProcess(process.execPath, ["-e", script], { cwd: f.dir, input: prompt, env: process.env, timeoutMs: 3_000 });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).input, prompt);
  await assert.rejects(runHostProcess(path.join(f.dir, "not-an-executable"), [], { input: "prompt", timeoutMs: 3_000 }), { delivery: "notSent" });
  assert.throws(() => buildWakePrompt(watched, { ...event, id: "--invalid" }), /event.id/);
});

test("aborting a real resume waits for process exit before releasing its session lease", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const marker = path.join(f.dir, "child-pid.txt");
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000);`;
  const wake = createWakeHost({ home: f.dir, run: (_executable, _args, options) => runHostProcess(process.execPath, ["-e", script], options) });
  const pending = wake({ ...watched, supervisor: f.supervisor }, event, { signal: controller.signal });
  pending.catch(() => {});
  t.after(() => controller.abort());
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(marker), true);
  const pid = Number(fs.readFileSync(marker, "utf8"));
  const lockDir = path.join(f.dir, "wake-locks");
  assert.equal(fs.readdirSync(lockDir).length, 1);
  controller.abort();
  assert.equal(fs.readdirSync(lockDir).length, 1, "Cancellation must not synchronously release the live-process lease");
  await assert.rejects(pending, { delivery: "uncertain" });
  assert.deepEqual(fs.readdirSync(lockDir), []);
  assert.throws(() => process.kill(pid, 0), isMissingProcess);
});

test("real runner handles timeout, pre-start cancellation, and split UTF-8 output", async (t) => {
  const f = fixture(t);
  await assert.rejects(runHostProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.dir, input: "", timeoutMs: 50 }), { delivery: "uncertain" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runHostProcess(process.execPath, ["-e", "process.exit(99)"], { signal: controller.signal }), { delivery: "notSent" });
  const script = "process.stdout.write(Buffer.from([0xe2]));process.stderr.write(Buffer.from([0xe2]));setTimeout(()=>{process.stdout.write(Buffer.from([0x82,0xac]));process.stderr.write(Buffer.from([0x82,0xac]));},20);";
  const result = await runHostProcess(process.execPath, ["-e", script], { cwd: f.dir, input: "", timeoutMs: 3_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, String.fromCodePoint(0x20ac));
  assert.equal(result.stderr, String.fromCodePoint(0x20ac));
});
