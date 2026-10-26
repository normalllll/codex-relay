import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSupervision, hostIdentity, probeHost } from "../src/tasks/supervision.mjs";
import { ReplyOutbox } from "../src/tasks/outbox.mjs";

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
      if (tool === "list_threads") {
        assert.ok(args.limit <= 50, "Desktop list_threads accepts at most 50 recent threads");
        return { threads };
      }
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
  assert.equal(f.calls.find((call) => call.type === "list_threads").args.limit, 50);
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

test("a disconnected bridge is diagnosed before project selection or task creation", async (t) => {
  const f = fixture(t, { callApp: async () => { throw new Error("connect ECONNREFUSED isolated-relay-pipe"); } });
  const { threadId, ...base } = f.request;
  const result = await f.workflow.supervise({ ...base, createNew: true });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers.map((blocker) => blocker.code), ["desktopBridge"]);
  assert.match(result.blockers[0].message, /ECONNREFUSED/);
  assert.match(result.blockers[0].nextAction, /doctor/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.subscriptions.length, 0);
});

test("a new library-fix task keeps the supervisor project default without registering its edit target", async (t) => {
  const f = fixture(t);
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "relay-external-library-"));
  t.after(() => fs.rmSync(library, { recursive: true, force: true }));
  const { threadId, ...base } = f.request;
  const task = `Fix the shared component in ${library} and run its affected tests.`;
  const args = { ...base, createNew: true, task };
  const result = await f.workflow.supervise(args);
  assert.equal(result.status, "watching");
  assert.equal(result.ready, true);
  assert.equal(result.target.projectPath, f.directory);
  assert.equal(result.target.cwd, f.directory);
  const creation = f.calls.find((call) => call.type === "create_thread");
  assert.equal(creation.args.target.projectId, "project-1");
  assert.equal(creation.args.prompt, `${task}\n\n${base.doneWhen}`);
  assert.equal(f.projects.length, 1);
  assert.equal(f.subscriptions[0].goal.task, task);
  assert.equal((await f.workflow.supervise(args)).replayed, true);
  assert.equal(f.calls.filter((call) => call.type === "create_thread").length, 1);
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
  const result = await f.workflow.preflight({ threadId: "execution-1", projectId: "project-1" });
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
  const prompt = f.calls.find((call) => call.type === "send").args.message;
  assert.equal(prompt, `${f.request.task}\n\n${f.request.doneWhen}`);
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
    if (tool === "list_threads") assert.ok(args.limit <= 50, "Pending resolution must respect the desktop limit");
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
  assert.equal(f.calls.find((call) => call.type === "create_thread").args.prompt, `${request.task}\n\n${request.doneWhen}`);
  assert.equal(f.calls.filter((call) => call.type === "send").length, 0, "The nonempty native creation prompt already submitted the task");
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

test("an incomplete legacy plan without a project binding is preserved and blocked explicitly", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.outbox.execute("supervise:operation-1", f.request, async (transaction) => {
    await transaction.stage("plan", async () => ({ supervisor: f.dependencies.identity(), target: { threadId: "execution-1" } }));
    throw new Error("Interrupted old operation");
  }));
  const result = await f.workflow.supervise(f.request);
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0].code, "legacyProjectBinding");
  assert.equal(f.calls.length, 0);
  assert.equal(f.outbox.inspect("supervise:operation-1").stages.plan.result.target.threadId, "execution-1");
});

test("explicit cross-project title selection inspects missing membership rather than discarding it", async (t) => {
  const f = fixture(t);
  const other = { projectId: "shared-project", path: path.join(f.directory, "shared") };
  f.projects.push(other);
  f.threads.push({ kind: "codex", id: "shared-executor", title: "Shared implementation", status: "idle" });
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, args) => tool === "read_thread" && args.threadId === "shared-executor"
    ? { thread: { id: args.threadId, projectId: other.projectId, cwd: other.path } } : app(tool, args) });
  const { threadId: _threadId, ...request } = f.request;
  const result = await workflow.supervise({ ...request, threadTitle: "Shared implementation", projectId: other.projectId });
  assert.equal(result.status, "watching", JSON.stringify(result));
  assert.equal(result.target.threadId, "shared-executor");
  assert.equal(result.target.projectId, other.projectId);
  assert.equal(f.calls.find((call) => call.type === "send").args.threadId, "shared-executor");
});

test("an unregistered supervisor directory cannot adopt the executor project implicitly", async (t) => {
  const f = fixture(t, { identity: () => ({ host: "codex", threadId: "supervisor-1", cwd: path.join(os.tmpdir(), "unregistered-supervisor-project") }) });
  const blocked = await f.workflow.supervise(f.request);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.some((item) => item.code === "projectSelection"));
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "create_thread", "send"].includes(call.type)));
  const explicit = await f.workflow.supervise({ ...f.request, projectId: "project-1" });
  assert.equal(explicit.status, "watching", "An explicit destination authorizes a project different from the supervisor directory");
  assert.equal(explicit.target.projectId, "project-1");
  assert.equal(explicit.target.projectPath, f.directory);
});

test("a title retry validates the persisted executor after the original title changes", async (t) => {
  const f = fixture(t, { ensureService: async () => { throw new Error("Service unavailable before dispatch"); } });
  const { threadId, ...base } = f.request;
  const args = { ...base, threadTitle: "Execution" };
  await assert.rejects(f.workflow.supervise(args), /Service unavailable/);
  const originalTarget = f.outbox.inspect("supervise:operation-1").stages.plan.result.target;
  assert.deepEqual(originalTarget, { threadId: "execution-1", hostId: "local", title: "Execution", projectId: "project-1", projectPath: f.directory, cwd: f.directory });
  f.threads[1].title = "Renamed execution";
  f.threads.push({ ...f.threads[1], id: "replacement", title: "Execution" });
  f.calls.length = 0;
  const retry = await createSupervision({ ...f.dependencies, ensureService: async () => ({ running: true }) }).supervise(args);
  assert.equal(retry.threadId, "execution-1");
  assert.equal(retry.target.title, "Renamed execution");
  assert.deepEqual(f.calls.filter((call) => call.type === "policy").map((call) => call.args.threadId), ["execution-1", "supervisor-1"]);
  assert.deepEqual(f.subscriptions[0].target, retry.target);
  assert.equal(f.calls.find((call) => call.type === "send").args.subscriptionId, retry.subscriptionId);
  assert.equal(f.calls.find((call) => call.type === "send").args.threadId, retry.target.threadId);
});

test("a title retry blocks when its bound executor changes working directory", async (t) => {
  const f = fixture(t, { ensureService: async () => { throw new Error("Service unavailable"); } });
  const { threadId, ...base } = f.request;
  const args = { ...base, threadTitle: "Execution" };
  await assert.rejects(f.workflow.supervise(args), /Service unavailable/);
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, ensureService: async () => assert.fail("A moved target cannot start service"),
    callApp: async (tool, input) => tool === "read_thread" && input.threadId === "execution-1"
      ? { thread: { id: input.threadId, cwd: path.join(f.directory, "moved") } } : app(tool, input) });
  const retry = await workflow.supervise(args);
  assert.equal(retry.status, "blocked");
  assert.ok(retry.blockers.some((item) => item.code === "executionChat" && /cwd/.test(item.message)));
  assert.equal(f.subscriptions.length, 0);
});

test("changed retry input is rejected before host discovery or preflight reads", async (t) => {
  const f = fixture(t, { ensureService: async () => { throw new Error("Service unavailable"); } });
  await assert.rejects(f.workflow.supervise(f.request), /Service unavailable/);
  const workflow = createSupervision({ ...f.dependencies, identity: () => assert.fail("Changed input cannot discover the host"),
    callApp: async () => assert.fail("Changed input cannot read desktop state") });
  await assert.rejects(workflow.supervise({ ...f.request, task: "Changed task" }), /different input/);
});

test("created local execution validates its project working directory before subscription", async (t) => {
  const f = fixture(t);
  f.threads.push({ kind: "codex", id: "created-1", title: "Created", projectId: "project-1", status: "idle" });
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, input) => tool === "read_thread" && input.threadId === "created-1"
    ? { thread: { id: input.threadId, cwd: path.join(f.directory, "wrong-directory") } } : app(tool, input) });
  const { threadId, ...base } = f.request;
  const args = { ...base, createNew: true };
  await assert.rejects(workflow.supervise(args), /cwd/);
  assert.equal(f.subscriptions.length, 0);
  await assert.rejects(workflow.supervise(args), /cwd/);
  assert.equal(f.calls.filter((call) => call.type === "create_thread").length, 1, "Validation failure must not create a replacement execution");
});

test("created worktrees retain project membership while allowing a separate working directory", async (t) => {
  const f = fixture(t);
  f.threads.push({ kind: "codex", id: "created-1", title: "Created worktree", projectId: "project-1", status: "idle" });
  const app = f.dependencies.callApp;
  const cwd = path.join(f.directory, "worktrees", "created");
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, input) => tool === "read_thread" && input.threadId === "created-1"
    ? { thread: { id: input.threadId, cwd } } : app(tool, input) });
  const { threadId, ...base } = f.request;
  const ready = await workflow.supervise({ ...base, createNew: true, worktree: true });
  assert.equal(ready.status, "watching");
  assert.equal(ready.target.cwd, cwd);
  assert.equal(ready.target.projectPath, f.directory);
  assert.deepEqual(f.subscriptions[0].target, ready.target);
  assert.deepEqual(f.outbox.inspect("supervise:operation-1").stages.plan.result.target, ready.target);
});

test("pending creation pins its original project even when path lookup order changes", async (t) => {
  const f = fixture(t);
  let resolved = false;
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, input) => {
    if (tool === "create_thread") { f.calls.push({ type: tool, args: input }); return { clientThreadId: "pending-created" }; }
    if (tool === "list_threads" && resolved) return { threads: [...f.threads, { kind: "codex", id: "created-1", clientThreadId: "pending-created", projectId: "project-1", status: "idle" }] };
    return app(tool, input);
  } });
  const { threadId, ...base } = f.request;
  const args = { ...base, createNew: true, worktree: true };
  assert.equal((await workflow.supervise(args)).status, "pending");
  f.projects.unshift({ projectId: "different-project", path: f.directory });
  resolved = true;
  const ready = await workflow.supervise(args);
  assert.equal(ready.status, "watching");
  assert.equal(ready.target.projectId, "project-1");
  assert.equal(f.calls.filter((call) => call.type === "create_thread").length, 1);
});

test("created and pending-resolved executions cannot subscribe under a different project", async (t) => {
  for (const pending of [false, true]) {
    const f = fixture(t);
    const otherDirectory = path.join(f.directory, "other-project");
    f.projects.push({ projectId: "project-2", path: otherDirectory });
    let resolved = !pending;
    const created = { kind: "codex", id: "created-1", clientThreadId: "pending-created", title: "Created", projectId: "project-2", status: "idle" };
    const app = f.dependencies.callApp;
    const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, input) => {
      if (tool === "create_thread") { f.calls.push({ type: tool, args: input }); return pending ? { clientThreadId: "pending-created" } : { threadId: "created-1" }; }
      if (tool === "list_threads") return { threads: [...f.threads, ...(resolved ? [created] : [])] };
      if (tool === "read_thread" && input.threadId === "created-1") return { thread: { id: input.threadId, cwd: otherDirectory } };
      return app(tool, input);
    } });
    const { threadId, ...base } = f.request;
    const args = { ...base, createNew: true, worktree: pending };
    if (pending) {
      assert.equal((await workflow.supervise(args)).status, "pending");
      resolved = true;
    }
    await assert.rejects(workflow.supervise(args), /projectId/);
    assert.equal(f.subscriptions.length, 0);
    assert.equal(f.calls.filter((call) => call.type === "create_thread").length, 1);
  }
});

test("duplicate registered project paths require an explicit project ID", async (t) => {
  const f = fixture(t);
  f.projects.push({ projectId: "project-2", path: f.directory });
  const { threadId, ...base } = f.request;
  const args = { ...base, createNew: true };
  const blocked = await f.workflow.supervise(args);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.some((item) => item.code === "projectSelection" && /ambiguous/.test(item.message)));
  assert.ok(!f.calls.some((call) => call.type === "create_thread"));
});

test("local creation cannot override the selected project directory with expectedCwd", async (t) => {
  const f = fixture(t);
  const { threadId, ...base } = f.request;
  const blocked = await f.workflow.supervise({ ...base, createNew: true, expectedCwd: path.join(f.directory, "different") });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.some((item) => item.code === "targetDirectory"));
  assert.ok(!f.calls.some((call) => ["service", "create_thread", "subscribe"].includes(call.type)));
});

test("omitted projects resolve from exact existing chats for implicit and explicit cross-project supervision", async (t) => {
  const f = fixture(t);
  f.projects.length = 0;
  // The desktop often splits project membership and cwd between these two tools.
  const implicit = await f.workflow.preflight({ threadId: "execution-1" });
  assert.equal(implicit.ready, true, JSON.stringify(implicit.blockers));
  assert.equal(implicit.project.projectId, "project-1");
  assert.equal(implicit.project.path, f.directory);
  const external = path.join(f.directory, "external-supervisor");
  const workflow = createSupervision({ ...f.dependencies, identity: () => ({ host: "codex", threadId: "supervisor-1", cwd: external }) });
  assert.equal((await workflow.preflight({ threadId: "execution-1" })).ready, false, "Do not adopt the executor project implicitly");
  const explicit = await workflow.supervise({ ...f.request, projectPath: f.directory });
  assert.equal(explicit.status, "watching");
  assert.equal(explicit.target.projectId, "project-1");
  assert.equal(explicit.target.cwd, f.directory);
});

test("omitted project setup retries retain the saved executor and never reselect a renamed title", async (t) => {
  const f = fixture(t);
  f.projects.length = 0;
  let unavailable = true;
  const workflow = createSupervision({ ...f.dependencies, ensureService: async () => {
    if (unavailable) throw new Error("Service unavailable");
    return { running: true };
  } });
  const { threadId, ...base } = f.request;
  const args = { ...base, threadTitle: "Execution", projectPath: f.directory };
  await assert.rejects(workflow.supervise(args), /Service unavailable/);
  f.threads.find((thread) => thread.id === "execution-1").title = "Renamed";
  f.threads.push({ kind: "codex", id: "replacement", title: "Execution", projectId: "project-1" });
  unavailable = false;
  const result = await workflow.supervise(args);
  assert.equal(result.target.threadId, "execution-1");
  assert.equal(f.calls.filter((call) => call.type === "send").length, 1);
  assert.ok(!f.calls.some((call) => call.type === "create_thread"));
});

test("an exact older executor outside recent results confirms an explicitly selected omitted project", async (t) => {
  const f = fixture(t);
  f.projects.length = 0;
  f.threads.splice(1);
  const directory = path.join(f.directory, "other-project");
  fs.mkdirSync(directory);
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, args) => tool === "read_thread" && args.threadId === "old-executor"
    ? { thread: { id: args.threadId, cwd: directory, projectId: "other-project" } } : app(tool, args) });
  for (const selector of [{ projectPath: directory }, { projectId: "other-project" }]) {
    const result = await workflow.preflight({ ...selector, threadId: "old-executor" });
    assert.equal(result.ready, true, JSON.stringify(result.blockers));
    assert.equal(result.project.path, directory);
    assert.equal(result.target.threadId, "old-executor");
  }
  const implicit = await workflow.preflight({ threadId: "old-executor" });
  assert.equal(implicit.ready, false, "Implicit selection stays in the supervisor project");
  assert.ok(implicit.blockers.some((blocker) => blocker.code === "executionChat"));
});

test("a saved pending worktree target retries by its bound ID after recent mapping disappears", async (t) => {
  const f = fixture(t);
  let mapped = true, subscriptions = 0;
  const app = f.dependencies.callApp;
  const cwd = path.join(f.directory, "worktree");
  const workflow = createSupervision({ ...f.dependencies,
    subscribe: async (input) => { if (++subscriptions === 1) throw new Error("Registration unavailable"); return input; },
    callApp: async (tool, args) => {
      if (tool === "create_thread") { f.calls.push({ type: tool, args }); return { clientThreadId: "pending-original" }; }
      if (tool === "list_threads") return { threads: [...f.threads, ...(mapped ? [{ id: "created", kind: "codex", clientThreadId: "pending-original", projectId: "project-1", cwd }] : [])] };
      if (tool === "read_thread" && args.threadId === "created") return { thread: { id: args.threadId, cwd } };
      return app(tool, args);
    } });
  const { threadId, ...base } = f.request;
  const args = { ...base, createNew: true, worktree: true };
  await assert.rejects(workflow.supervise(args), /Registration unavailable/);
  mapped = false;
  f.projects.length = 0;
  const retry = await workflow.supervise(args);
  assert.equal(retry.status, "watching");
  assert.equal(retry.target.threadId, "created");
  assert.equal(retry.target.projectPath, f.directory);
  assert.equal(retry.target.cwd, cwd);
  assert.equal(f.calls.filter((call) => call.type === "create_thread").length, 1);
});

test("pending worktree supervision rejects multiple resolved identities before registration", async (t) => {
  const f = fixture(t);
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, args) => {
    if (tool === "create_thread") return { clientThreadId: "ambiguous-pending" };
    if (tool === "list_threads") return { threads: [...f.threads, ...["first", "second"].map((id) => ({ id, kind: "codex", projectId: "project-1", clientThreadId: "ambiguous-pending" }))] };
    return app(tool, args);
  } });
  const { threadId, ...base } = f.request;
  await assert.rejects(workflow.supervise({ ...base, createNew: true, worktree: true }), /multiple chats/);
  assert.equal(f.subscriptions.length, 0);
});

test("a verified setup project survives catalogue omission before creation without adopting a new root", async (t) => {
  const f = fixture(t, { ensureService: async () => { throw new Error("Service unavailable"); } });
  const { threadId, ...base } = f.request;
  const args = { ...base, createNew: true, worktree: true };
  await assert.rejects(f.workflow.supervise(args), /Service unavailable/);
  f.projects.length = 0;
  f.threads.splice(1);
  const cwd = path.join(f.directory, "worktree");
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, ensureService: async () => ({ running: true }),
    callApp: async (tool, input) => tool === "read_thread" && input.threadId === "created-1"
      ? { thread: { id: input.threadId, cwd } } : app(tool, input) });
  const retry = await workflow.supervise(args);
  assert.equal(retry.status, "watching");
  assert.equal(retry.target.projectPath, f.directory);
  assert.equal(retry.target.cwd, cwd);
  f.projects.push({ projectId: "other-project", path: f.directory });
  const conflict = await workflow.preflight({ projectId: "project-1", createNew: true }, { verifiedProject: { projectId: "project-1", path: f.directory } });
  assert.equal(conflict.ready, false, "Current explicit catalogue conflicts still block a saved project");
});

test("a same-title chat confirmed in another omitted project cannot block explicit title selection", async (t) => {
  const f = fixture(t);
  f.projects.length = 0;
  delete f.threads[1].projectId;
  f.threads.push({ id: "other-title", kind: "codex", title: "Execution" });
  const app = f.dependencies.callApp;
  const workflow = createSupervision({ ...f.dependencies, callApp: async (tool, args) => {
    if (tool === "read_thread" && args.threadId === "other-title")
      return { thread: { id: args.threadId, projectId: "other-project" } };
    if (tool === "read_thread" && args.threadId === "execution-1")
      return { thread: { id: args.threadId, projectId: "project-1", cwd: f.directory } };
    return app(tool, args);
  } });
  const result = await workflow.preflight({ projectPath: f.directory, threadTitle: "Execution" });
  assert.equal(result.ready, true, JSON.stringify(result.blockers));
  assert.equal(result.target.threadId, "execution-1");
});

test("preflight retains raw listing conflicts for exact requested target identity checks", async (t) => {
  const f = fixture(t);
  f.threads[1].hostId = "remote";
  const result = await f.workflow.preflight({ threadId: "execution-1", projectId: "project-1" });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "executionChat" && /identity is inconsistent/.test(blocker.message)));
  assert.ok(!f.calls.some((call) => ["service", "subscribe", "send", "create_thread"].includes(call.type)));
});
