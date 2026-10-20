import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSupervision, hostIdentity, probeHost } from "../supervision.mjs";
import { ReplyOutbox } from "../outbox.mjs";

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-supervision-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], subscriptions = [];
  const projects = [{ projectId: "project-1", path: directory }];
  const threads = [
    { kind: "codex", id: "supervisor-1", title: "Supervisor", projectId: "project-1", status: "idle" },
    { kind: "codex", id: "execution-1", title: "Execution", projectId: "project-1", status: "idle" },
  ];
  const outbox = new ReplyOutbox(directory);
  const dependencies = {
    identity: () => ({ host: "codex", threadId: "supervisor-1", cwd: directory }),
    discover: () => process.execPath,
    probe: async (host, executable) => ({ ok: true, executable }),
    modelPolicy: async (args) => { calls.push({ type: "policy", args }); return { ok: true, tier: "standard" }; },
    getService: async () => ({ running: true, channelSessions: [] }),
    ensureService: async () => { calls.push({ type: "service" }); return { running: true }; },
    subscribe: async (args) => { calls.push({ type: "subscribe", args }); subscriptions.push(structuredClone(args)); return args; },
    sendReply: async (args) => { calls.push({ type: "send", args }); return { sent: true }; },
    callApp: async (tool, args) => {
      calls.push({ type: tool, args });
      if (tool === "list_projects") return { projects };
      if (tool === "list_threads") return { threads };
      if (tool === "read_thread") return { thread: { id: args.threadId, cwd: directory }, turns: [] };
      if (tool === "create_thread") return { threadId: "created-1" };
      throw new Error(`Unexpected app tool ${tool}`);
    },
    outbox,
    ...overrides,
  };
  const workflow = createSupervision(dependencies);
  const request = { requestId: "operation-1", threadId: "execution-1", task: "Implement the requested change", doneWhen: "The affected checks pass" };
  return { directory, calls, subscriptions, projects, threads, outbox, dependencies, workflow, request };
}

test("host identity uses actual current environment and gives Claude precedence without guessing", () => {
  assert.deepEqual(hostIdentity({ CODEX_THREAD_ID: "codex-current" }, "/work"), { host: "codex", threadId: "codex-current", cwd: "/work" });
  assert.deepEqual(hostIdentity({ CODEX_THREAD_ID: "inherited-codex", CLAUDE_CODE_SESSION_ID: "claude-current", CLAUDE_CODE_DISABLE_FAST_MODE: "1" }, "/work"),
    { host: "claude", sessionId: "claude-current", cwd: "/work", fastDisabled: true });
  assert.equal(hostIdentity({ CODEX_THREAD_ID: "inherited-codex", CLAUDECODE: "1" }, "/work").host, null);
  assert.equal(hostIdentity({}, "/work").host, null);
});

test("Codex queue capability requires both exact-session and message options", async () => {
  const run = async () => ({ code: 0, stdout: "--thread", stderr: "" });
  assert.equal((await probeHost("codex", process.execPath, { run })).ok, false);
  assert.equal((await probeHost("codex", process.execPath, { run: async () => ({ code: 0, stdout: "--thread --message" }) })).ok, true);
});

test("automatic Codex supervision prefers a verified queue and preserves current identity", async (t) => {
  const f = fixture(t);
  const result = await f.workflow.preflight({ threadId: "execution-1" });
  assert.equal(result.ready, true);
  assert.equal(result.supervisor.threadId, "supervisor-1");
  assert.equal(result.supervisor.mode, "queue");
  assert.equal(result.supervisor.executable, process.execPath);
  assert.deepEqual(f.calls.filter((call) => call.type === "policy").map((call) => call.args.threadId), ["execution-1", "supervisor-1"], "Queue preserves the supervisor's session mode, so both sessions need Standard evidence");
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "create_thread", "send"].includes(call.type)));
});

test("desktop fallback needs a loaded supervisor and explicit Standard session evidence", async (t) => {
  const f = fixture(t, { probe: async () => ({ ok: false, reason: "Queue is unavailable" }),
    modelPolicy: async ({ threadId }) => ({ ok: threadId !== "supervisor-1", reason: "Supervisor tier is unknown" }) });
  const blocked = await f.workflow.preflight({ threadId: "execution-1" });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.some((item) => item.code === "supervisorStandardMode"));
  const ready = await createSupervision({ ...f.dependencies, modelPolicy: async () => ({ ok: true }) }).preflight({ threadId: "execution-1" });
  assert.equal(ready.ready, true);
  assert.equal(ready.supervisor.mode, "desktop");
  f.threads[0].status = "notLoaded";
  assert.equal((await createSupervision({ ...f.dependencies, modelPolicy: async () => ({ ok: true }) }).preflight({ threadId: "execution-1" })).ready, false);
});

test("missing current identity blocks before discovery or any side effect", async (t) => {
  const f = fixture(t, { identity: () => ({ host: null }) });
  const result = await f.workflow.supervise(f.request);
  assert.equal(result.status, "blocked");
  assert.equal(f.calls.length, 0);
  assert.equal(f.outbox.inspect("supervise:operation-1").status, "unknown");
});

test("a shared MCP process cannot use an inherited stale session as the current supervisor", async (t) => {
  const f = fixture(t);
  const blocked = await f.workflow.supervise(f.request, { fromMcp: true });
  assert.equal(blocked.status, "blocked");
  assert.equal(f.calls.length, 0);
  const actual = { host: "codex", threadId: "supervisor-1", cwd: f.directory };
  const ready = await f.workflow.supervise({ ...f.request, supervisor: actual }, { fromMcp: true });
  assert.equal(ready.status, "watching");
  assert.equal(ready.supervisor.threadId, actual.threadId);
});

test("queue availability cannot bypass unknown or Fast supervisor session settings", async (t) => {
  const f = fixture(t, { modelPolicy: async ({ threadId }) => ({ ok: threadId !== "supervisor-1", tier: threadId === "supervisor-1" ? "fast" : "standard" }) });
  const result = await f.workflow.supervise(f.request);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.code === "supervisorStandardMode"));
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "create_thread", "send"].includes(call.type)));
});

test("ambiguous exact titles and self-supervision block dispatch", async (t) => {
  const f = fixture(t);
  f.threads.push({ ...f.threads[1], id: "execution-2" });
  const { threadId, ...request } = f.request;
  const ambiguous = await f.workflow.supervise({ ...request, threadTitle: "Execution" });
  assert.equal(ambiguous.status, "blocked");
  assert.ok(ambiguous.blockers.some((item) => item.code === "targetSelection"));
  const self = await f.workflow.supervise({ ...f.request, threadId: "supervisor-1" });
  assert.equal(self.status, "blocked");
  assert.ok(self.blockers.some((item) => item.code === "separateExecution"));
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "create_thread", "send"].includes(call.type)));
});

test("a live Claude session without a channel never launches a competing resume writer", async (t) => {
  let probes = 0;
  const f = fixture(t, { identity: () => ({ host: "claude", sessionId: "current-claude", fastDisabled: true }),
    probe: async () => { probes++; return { ok: true }; } });
  const automatic = await f.workflow.supervise(f.request);
  assert.equal(automatic.status, "blocked");
  assert.ok(automatic.blockers.some((item) => item.code === "claudeLiveChannel"));
  assert.equal(probes, 0);
  const explicit = await f.workflow.preflight({ threadId: "execution-1", supervisor: { host: "claude", sessionId: "current-claude", mode: "resume", cwd: f.directory } });
  assert.equal(explicit.ready, false);
  assert.ok(explicit.blockers.some((item) => item.code === "resumeSessionIdle"));
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "create_thread", "send"].includes(call.type)));
});

test("an existing bound Claude channel is selected only with parent Fast mode disabled", async (t) => {
  const f = fixture(t, { identity: () => ({ host: "claude", sessionId: "current-claude", fastDisabled: true }),
    getService: async () => ({ running: true, channelSessions: ["current-claude"] }) });
  const result = await f.workflow.preflight({ threadId: "execution-1" });
  assert.equal(result.ready, true);
  assert.equal(result.supervisor.mode, "channel");
  const blocked = await createSupervision({ ...f.dependencies, identity: () => ({ host: "claude", sessionId: "current-claude", fastDisabled: false }) }).preflight({ threadId: "execution-1" });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.some((item) => item.code === "supervisorStandardMode"));
});

test("existing execution setup persists goal and Standard policy before dispatch and replays by request ID", async (t) => {
  const f = fixture(t);
  const first = await f.workflow.supervise(f.request);
  assert.equal(first.status, "watching");
  assert.deepEqual(f.subscriptions[0].goal, { task: f.request.task, doneWhen: f.request.doneWhen });
  assert.deepEqual(f.subscriptions[0].policy, { noFast: true });
  assert.equal(f.subscriptions[0].supervisor.threadId, "supervisor-1");
  assert.ok(f.calls.findIndex((call) => call.type === "subscribe") < f.calls.findIndex((call) => call.type === "send"));
  assert.match(f.calls.find((call) => call.type === "send").args.message, /Completion criteria:/);
  assert.match(f.calls.find((call) => call.type === "send").args.message, /Do not enable Fast/);
  const replay = await createSupervision(f.dependencies).supervise({ ...f.request });
  assert.equal(replay.replayed, true);
  assert.equal(replay.subscriptionId, first.subscriptionId);
  assert.equal(f.calls.filter((call) => call.type === "send").length, 1);
  assert.equal(f.subscriptions.length, 1);
  await assert.rejects(f.workflow.supervise({ ...f.request, task: "Different task" }), /different input/);
});

test("pending worktree setup resolves on identical retry without creating duplicate executions", async (t) => {
  const f = fixture(t);
  let resolved = false;
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, args) => {
    if (tool === "create_thread") { f.calls.push({ type: tool, args }); return { clientThreadId: "pending-execution" }; }
    if (tool === "list_threads" && resolved) return { threads: [...f.threads, { kind: "codex", id: "created-1", clientThreadId: "pending-execution", projectId: "project-1", status: "idle" }] };
    return app(tool, args);
  } });
  const { threadId, ...base } = f.request;
  const request = { ...base, createNew: true, worktree: true };
  const pending = await workflow.supervise(request);
  assert.equal(pending.status, "pending");
  assert.equal(pending.pendingClientThreadId, "pending-execution");
  assert.equal(f.subscriptions.length, 0);
  resolved = true;
  const ready = await workflow.supervise(request);
  assert.equal(ready.status, "watching");
  assert.equal(ready.threadId, "created-1");
  assert.equal(f.calls.filter((call) => call.type === "create_thread").length, 1);
  assert.equal(f.calls.find((call) => call.type === "create_thread").args.target.environment.type, "worktree");
  assert.equal(f.calls.filter((call) => call.type === "send").length, 0, "The creation prompt already dispatched the task");
  assert.equal(f.subscriptions.length, 1);
});

test("unknown or Fast model policy prevents creation and service mutation", async (t) => {
  const f = fixture(t, { modelPolicy: async () => ({ ok: false, tier: "unknown", reason: "No explicit session tier" }) });
  const { threadId, ...base } = f.request;
  for (const tier of ["unknown", "fast"]) {
    const workflow = createSupervision({ ...f.dependencies, modelPolicy: async () => ({ ok: false, tier, reason: `${tier} policy` }) });
    const blocked = await workflow.supervise({ ...base, createNew: true });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.some((item) => item.code === "executionStandardMode"));
  }
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "create_thread", "send"].includes(call.type)));
});

test("service startup failure sends no task and remains safely retryable", async (t) => {
  const f = fixture(t, { ensureService: async () => { throw new Error("Service cannot start"); } });
  await assert.rejects(f.workflow.supervise(f.request), { message: "Service cannot start", delivery: "notSent" });
  assert.ok(!f.calls.some((call) => ["subscribe", "create_thread", "send"].includes(call.type)));
  const retry = await createSupervision({ ...f.dependencies, ensureService: async () => ({ running: true }) }).supervise(f.request);
  assert.equal(retry.status, "watching");
  assert.equal(f.calls.filter((call) => call.type === "send").length, 1);
});

test("an explicit project mismatch is blocked rather than replaced by the selected chat's project", async (t) => {
  const f = fixture(t);
  const result = await f.workflow.supervise({ ...f.request, projectPath: path.join(f.directory, "another-project") });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.code === "projectSelection"));
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "create_thread", "send"].includes(call.type)));
});

test("a completed receipt is replayable even when host discovery is temporarily unavailable", async (t) => {
  const f = fixture(t);
  const first = await f.workflow.supervise(f.request);
  assert.equal(first.status, "watching");
  const offline = createSupervision({ ...f.dependencies, identity: () => ({ host: null }),
    callApp: async () => assert.fail("A completed receipt needs no desktop access") });
  const replay = await offline.supervise(f.request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.subscriptionId, first.subscriptionId);
  assert.equal(f.calls.filter((call) => call.type === "send").length, 1);
});
