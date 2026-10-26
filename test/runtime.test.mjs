import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parseToolArguments } from "../cli.mjs";
import { WatchStore } from "../src/watch/watch-store.mjs";
import { ReplyOutbox } from "../src/tasks/outbox.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runtime = process.execPath;
const sqliteModule = process.versions.bun ? "bun:sqlite" : "node:sqlite";
const sqlite = await import(sqliteModule);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-runtime-"));
  const id = crypto.randomUUID();
  const pipe = (name) => process.platform === "win32" ? `\\\\.\\pipe\\relay-test-${id}-${name}` : path.join(dir, `${name}.sock`);
  const relay = path.join(dir, "relay");
  const codex = path.join(dir, "codex");
  fs.mkdirSync(relay); fs.mkdirSync(codex);
  const db = process.versions.bun ? new sqlite.Database(path.join(codex, "state_42.sqlite")) : new sqlite.DatabaseSync(path.join(codex, "state_42.sqlite"));
  db.exec("create table threads(id text, archived integer, updated_at_ms integer); insert into threads values ('caller-thread',0,123)");
  db.close();
  const env = { ...process.env, CODEX_RELAY_HOME: relay, CODEX_HOME: codex, CODEX_RELAY_PIPE: pipe("control"), CODEX_RELAY_IPC_PIPE: pipe("ipc"), CODEX_APP_TOOLS_PIPE_PATH: pipe("app"), CODEX_THREAD_ID: "caller-thread" };
  const children = [];
  const servers = [];
  t.after(async () => {
    if (env.CODEX_RELAY_DAEMON_PIPE && fs.existsSync(path.join(relay, "daemon-token"))) await cli("service", "stop");
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : once(child, "exit").catch(() => {})));
    for (const server of servers) { server.close(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const child = (file, args = []) => {
    const result = spawn(runtime, [path.join(root, file), ...args], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    children.push(result); return result;
  };
  const cli = async (...args) => {
    const proc = child("cli.mjs", args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (part) => { stdout += part; });
    proc.stderr.on("data", (part) => { stderr += part; });
    const [code] = await once(proc, "exit");
    return { code, value: JSON.parse(stdout.trim()), stderr };
  };
  return { dir, relay, codex, env, child, cli, servers, pipe };
}

async function mockDesktop(f, handler, { ipc = true, ipcState = () => ({}), ipcRequests = [] } = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        if (request.params?.tool === "create_thread")
          assert.ok(typeof request.params.arguments?.prompt === "string" && request.params.arguments.prompt.length > 0,
            "The installed desktop creation schema rejects empty prompts");
        if (request.params?.tool === "send_message_to_thread")
          assert.equal(request.params.arguments?.threadId, "caller-thread", "Only supervisor wakeups may use delegated app-tool delivery");
        const result = request.params?.tool === "list_threads" && request.params.arguments?.limit > 50
          ? { appError: { code: -32602, message: "list_threads.limit must be at most 50" } }
          : request.params?.tool === "send_message_to_thread" ? success({ sent: true })
          : handler(request);
        const payload = Buffer.from(JSON.stringify(result?.appError
          ? { jsonrpc: "2.0", id: request.id, error: result.appError }
          : { jsonrpc: "2.0", id: request.id, result }));
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
      }
    });
  });
  server.on("close", () => { for (const socket of sockets) socket.destroy(); });
  f.servers.push(server);
  server.listen(f.pipe("app")); await once(server, "listening");
  if (ipc) await mockMessageIpc(f, handler, ipcState, ipcRequests);
  f.child("relay-server.mjs");
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(f.relay, "relay.log")) && fs.readFileSync(path.join(f.relay, "relay.log"), "utf8").includes("listening")) return;
    await pause(20);
  }
  throw new Error("Test bridge did not start");
}

async function mockMessageIpc(f, handler, state, requests) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    const send = (value) => {
      const bytes = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(bytes.length + 4);
      frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); socket.write(frame);
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        requests.push(message);
        const respond = (result) => send({ type: "response", requestId: message.requestId, ...result });
        if (message.method === "initialize") respond({ resultType: "success", result: { clientId: "relay-client" } });
        else if (message.method === "thread-owner-discovery") respond({ resultType: "success", handledByClientId: "window-1" });
        else if (message.method === "thread-follower-read-model-settings") respond({ resultType: "success", method: message.method,
          handledByClientId: "window-1", result: { settings: { resumeState: "resumed" } } });
        else if (message.method === "thread-stream-following-changed") {
          if (!message.params.following) continue;
          send({ type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "window-1", version: 11,
            params: { hostId: "local", conversationId: message.params.conversationId, change: { type: "snapshot", revision: 1,
              conversationState: { id: message.params.conversationId, hostId: "local", resumeState: "resumed", turns: [],
                threadRuntimeStatus: { type: "idle" }, latestThreadSettings: { serviceTier: "default" }, ...state(message.params.conversationId) } } } });
        } else if (message.method === "thread-follower-start-turn" || message.method === "thread-follower-steer-turn") {
          // Observe IPC writes separately from the app-tool transport.
          const input = message.params.turnStart?.request?.input ?? message.params.input;
          const result = handler({ params: { tool: "submit_thread", arguments: { threadId: message.params.conversationId, prompt: input[0].text } } });
          if (result.success === false) { socket.destroy(); continue; }
          const accepted = message.method === "thread-follower-start-turn"
            ? { turn: { id: "accepted-turn", status: "inProgress" } } : { turnId: "running-turn" };
          respond({ resultType: "success", handledByClientId: "window-1", method: message.method, result: { result: accepted } });
        } else assert.fail(`Unexpected message IPC ${message.method}`);
      }
    });
  });
  server.on("close", () => { for (const socket of sockets) socket.destroy(); });
  f.servers.push(server); server.listen(f.pipe("ipc")); await once(server, "listening");
}

const success = (value) => ({ success: true, contentItems: [{ type: "text", text: JSON.stringify(value) }] });

test("CLI parser handles UTF-8 prompt files, typed flags, and rejects ambiguous input", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "prompt.txt"); fs.writeFileSync(file, "\uFEFFLine one\nLine two $value `literal`");
  assert.deepEqual(parseToolArguments("start", ["--project", "C:/work", "--prompt-file", file, "--worktree"]), { projectPath: "C:/work", prompt: "Line one\nLine two $value `literal`", worktree: true });
  assert.throws(() => parseToolArguments("start", ["--prompt", "a", "--prompt-file", file]), /Duplicate/);
  assert.throws(() => parseToolArguments("wait", ["one", "two"]), /exactly one/);
  assert.throws(() => parseToolArguments("wait", ["one", "--typo"]), /Unknown option/);
});

test("Node/Bun SQLite adapter discovers numbered databases read-only", async (t) => {
  const f = fixture(t);
  const proc = spawnSync(runtime, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(new URL("../src/desktop/codex-client.mjs", import.meta.url).href)}); console.log(JSON.stringify({file:m.discoverStateDatabase(),ids:m.recentThreadIds()}))`], { env: f.env, encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout.trim());
  assert.ok(result.file.endsWith("state_42.sqlite"));
  assert.deepEqual(result.ids, ["caller-thread"]);
});

test("real CLI and bridge forward projects/start/status/wait/reply and resolve pending worktrees", async (t) => {
  const f = fixture(t);
  const calls = [];
  await mockDesktop(f, (request) => {
    calls.push(request);
    const { tool, arguments: args } = request.params;
    if (tool === "list_projects") return success({ projects: [{ projectId: "project-1", label: "Example", path: f.dir }] });
    if (tool === "list_threads") return success({ threads: [{ kind: "codex", id: "worktree-thread", clientThreadId: "pending-1", status: "idle" }] });
    if (tool === "create_thread") return success(args.target.environment.type === "worktree" ? { clientThreadId: "pending-1" } : { threadId: "target-thread" });
    if (tool === "wait_threads") return success({ polls: [{ thread: { id: "target-thread", status: { type: "idle" } }, latestTurn: { status: "completed" }, latestAssistantMessage: { text: "Finished", phase: "final_answer" } }] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, title: "Target", cwd: f.dir }, turns: [] });
    if (tool === "submit_thread") return success({ sent: true });
    throw new Error(`Unexpected tool ${tool}`);
  });
  assert.deepEqual((await f.cli("projects")).value, [{ projectId: "project-1", label: "Example", path: f.dir }]);
  const prompt = path.join(f.dir, "prompt.txt"); fs.writeFileSync(prompt, "Do the authorized task");
  assert.equal((await f.cli("start", "--project", f.dir, "--prompt-file", prompt)).value.threadId, "target-thread");
  const pending = await f.cli("start", "--project", f.dir, "--prompt-file", prompt, "--worktree");
  assert.equal(pending.value.status, "pending");
  assert.equal((await f.cli("resolve", pending.value.pendingClientThreadId)).value.threadId, "worktree-thread");
  assert.ok(calls.some((call) => call.params.tool === "list_threads" && call.params.arguments.limit === 50));
  assert.equal((await f.cli("status", "target-thread")).value.latestMessage.text, "Finished");
  assert.equal((await f.cli("wait", "target-thread", "--timeout-minutes", "0")).value.reason, "turnEnded");
  const input = path.join(f.dir, "reply.json"); fs.writeFileSync(input, JSON.stringify({ message: "Summarize", projectPath: f.dir }));
  const receipt = await f.cli("reply", "target-thread", "--input-file", input);
  assert.equal(receipt.value.sent, true, JSON.stringify(receipt.value));
  assert.equal(receipt.value.target.threadId, "target-thread");
  assert.equal(receipt.value.target.projectId, "project-1");
  assert.equal(receipt.value.target.cwd, f.dir);
  const instruction = calls.findLast((call) => call.params.tool === "submit_thread");
  assert.equal(instruction.params.arguments.prompt, "Summarize");
  assert.deepEqual(calls.filter((call) => call.params.tool === "create_thread").map((call) => call.params.arguments.prompt), ["Do the authorized task", "Do the authorized task"]);
  assert.deepEqual(calls.filter((call) => call.params.tool === "submit_thread").map((call) => call.params.arguments.prompt), ["Summarize"]);
  const before = calls.length;
  assert.equal((await f.cli("wait", "target-thread", "--timeout-minutes", "NaN")).code, 1);
  assert.equal(calls.length, before, "Invalid inputs must fail before desktop calls");
});

test("thread listing accepts the API maximum and rejects oversized CLI requests before dispatch", async (t) => {
  const f = fixture(t);
  const calls = [];
  await mockDesktop(f, (request) => {
    calls.push(request);
    assert.equal(request.params.tool, "list_threads");
    return success({ pinnedThreads: [{ kind: "codex", id: "pinned", title: "Pinned", status: "idle" }],
      threads: [{ kind: "codex", id: "recent", title: "Recent", status: "active" }] });
  });
  const listed = await f.cli("threads", "--limit", "50");
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.value.map((item) => item.threadId), ["pinned", "recent"]);
  assert.equal(calls[0].params.arguments.limit, 50);
  const before = calls.length;
  const oversized = await f.cli("threads", "--limit", "100");
  assert.equal(oversized.code, 1);
  assert.match(oversized.value.error, /limit.*allowed range/);
  assert.equal(calls.length, before);
});

test("CLI and MCP verify omitted projects through real thread metadata before start, resolve, and reply", async (t) => {
  const f = fixture(t), calls = [];
  const worktree = path.join(f.dir, "worktree");
  fs.mkdirSync(worktree);
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    calls.push({ tool, args });
    if (tool === "list_projects") return success({ projects: [{ projectId: "unrelated", path: path.join(f.dir, "other") }] });
    if (tool === "list_threads") return success({ threads: [
      { kind: "codex", id: "existing", projectId: "omitted-project", cwd: f.dir },
      { kind: "codex", id: "created", projectId: "omitted-project", cwd: f.dir },
      { kind: "codex", id: "worktree", clientThreadId: "pending", projectId: "omitted-project", cwd: worktree },
    ] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, kind: "codex", hostId: "local", cwd: args.threadId === "worktree" ? worktree : f.dir }, turns: [] });
    if (tool === "create_thread") return success(args.target.environment.type === "worktree" ? { clientThreadId: "pending" } : { threadId: "created" });
    if (tool === "submit_thread") return success({ sent: true });
    throw new Error(`Unexpected tool ${tool}`);
  });
  const discovered = await f.cli("projects", "--project", f.dir);
  assert.equal(discovered.code, 0, JSON.stringify(discovered.value));
  assert.equal(discovered.value[0].projectId, "omitted-project");
  assert.equal(discovered.value[0].path, f.dir);
  const started = await f.cli("start", "--project", f.dir, "--prompt", "Implement the task");
  assert.equal(started.value.target.projectId, "omitted-project", JSON.stringify(started.value));
  const pending = await f.cli("start", "--project", f.dir, "--prompt", "Use the worktree", "--worktree");
  assert.equal(pending.value.status, "pending");
  const resolved = await f.cli("resolve", pending.value.pendingClientThreadId);
  assert.equal(resolved.value.target.projectPath, f.dir, JSON.stringify(resolved.value));
  assert.equal(resolved.value.target.cwd, worktree);
  assert.deepEqual(calls.filter((call) => call.tool === "create_thread").map((call) => call.args.target.projectId), ["omitted-project", "omitted-project"]);
  const proc = f.child("mcp.mjs");
  let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_projects", arguments: { projectPath: f.dir } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_reply", arguments: { threadId: "existing", projectPath: f.dir, message: "Continue", requestId: "omitted-reply" } } },
  ].map(JSON.stringify).join("\n") + "\n");
  await once(proc, "exit");
  const responses = stdout.trim().split("\n").map(JSON.parse);
  for (const response of responses) assert.ok(!response.result.isError, JSON.stringify(response));
  assert.equal(JSON.parse(responses.find((item) => item.id === 1).result.content[0].text)[0].projectId, "omitted-project");
  assert.equal(JSON.parse(responses.find((item) => item.id === 2).result.content[0].text).target.threadId, "existing");
  assert.deepEqual(calls.filter((call) => call.tool === "submit_thread").map((call) => call.args.prompt), ["Continue"]);
});

test("pending start resolution retains the selected project and validates the actual worktree", async (t) => {
  const f = fixture(t);
  let projectId = "wrong-project";
  let omitted = false;
  const worktree = path.join(f.dir, "managed-worktree");
  fs.mkdirSync(worktree);
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    if (tool === "list_projects") return success({ projects: omitted ? [] : [{ projectId: "project-1", path: f.dir }, { projectId: "wrong-project", path: path.join(f.dir, "other") }] });
    if (tool === "create_thread") return success({ clientThreadId: "pending-worktree" });
    if (tool === "list_threads") return success({ threads: [{ kind: "codex", id: "resolved-worktree", clientThreadId: "pending-worktree", projectId }] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, projectId, cwd: worktree }, turns: [] });
    if (tool === "submit_thread") return success({ sent: true });
    throw new Error(`Unexpected pending creation tool ${tool}`);
  });
  const prompt = path.join(f.dir, "task.txt"); fs.writeFileSync(prompt, "The requested work");
  const pending = await f.cli("start", "--project", f.dir, "--prompt-file", prompt, "--worktree");
  assert.equal(pending.value.status, "pending");
  const wrongProject = await f.cli("resolve", pending.value.pendingClientThreadId);
  assert.equal(wrongProject.code, 1);
  assert.match(wrongProject.value.error, /projectId/);
  projectId = "project-1";
  omitted = true;
  const resolved = await f.cli("resolve", pending.value.pendingClientThreadId);
  assert.equal(resolved.code, 0, JSON.stringify(resolved.value));
  assert.equal(resolved.value.target.projectId, "project-1");
  assert.equal(resolved.value.target.cwd, worktree);
  assert.equal(resolved.value.target.projectPath, f.dir);
  const again = await f.cli("resolve", pending.value.pendingClientThreadId);
  assert.equal(again.value.threadId, resolved.value.threadId);
  const missing = await f.cli("resolve", "legacy-pending");
  assert.equal(missing.code, 1);
  assert.match(missing.value.error, /no saved project binding/);
});

test("bound CLI and MCP replies reject wrong recipients and preserve inspectable delivery identity", { timeout: 15_000 }, async (t) => {
  const f = fixture(t), writes = [], calls = [];
  const store = new WatchStore(f.relay);
  const target = { threadId: "bound-thread", hostId: "local", title: "App implementation", projectId: "project-1", projectPath: f.dir, cwd: f.dir };
  const supervisor = { host: "codex", threadId: "caller-thread" };
  const subscription = store.subscribe({ id: "bound-task", threadId: target.threadId, target, supervisor });
  const other = store.subscribe({ id: "another-task", threadId: "other-thread", target: { ...target, threadId: "other-thread" }, supervisor });
  const [event] = store.observe(subscription.id, { turnId: "turn-1", turnStatus: "completed", latestMessage: { text: "Review my work" } });
  let cwd = f.dir, projectId = "project-1", title = target.title, rejectSend = false, identityUnavailable = false;
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    calls.push({ tool, args });
    if (tool === "list_projects") return success({ projects: [{ projectId: "project-1", path: f.dir }, { projectId: "project-2", path: path.join(f.dir, "other-project") }] });
    if (tool === "list_threads") return success({ threads: [{ kind: "codex", id: target.threadId, title, projectId }] });
    if (tool === "read_thread") return identityUnavailable
      ? { success: false, contentItems: [{ text: "Identity temporarily unavailable" }] }
      : success({ thread: { id: args.threadId, title, projectId, cwd }, turns: [] });
    if (tool === "submit_thread") {
      writes.push(args);
      return rejectSend ? { success: false, contentItems: [{ text: "Connection lost after dispatch" }] } : success({ sent: true });
    }
    throw new Error(`Unexpected bound-reply tool ${tool}`);
  });
  const inputFile = path.join(f.dir, "bound-reply.json");
  const cliReply = async (input) => { fs.writeFileSync(inputFile, JSON.stringify(input)); return f.cli("reply", "--input-file", inputFile); };
  const mcpReply = async (input) => {
    const proc = f.child("mcp.mjs");
    let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_reply", arguments: input } }) + "\n");
    await once(proc, "exit");
    const response = JSON.parse(stdout.trim()).result;
    return { code: response.isError ? 1 : 0, value: JSON.parse(response.content[0].text) };
  };
  const firstInput = { subscriptionId: subscription.id, requestId: "bound-first", message: "Continue App work" };
  const first = await cliReply(firstInput);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  assert.deepEqual(first.value.target, target);
  assert.equal(writes[0].threadId, target.threadId);
  assert.equal(writes[0].prompt, firstInput.message);
  const delivery = (await f.cli("delivery", "--request-id", firstInput.requestId)).value;
  assert.deepEqual(delivery.stages.target.result, target);
  assert.deepEqual(delivery.stages.instruction.result.target, target);
  assert.deepEqual(delivery.result.target, target);

  const rejected = async (input, pattern, send = cliReply) => {
    const before = writes.length;
    const result = await send({ requestId: crypto.randomUUID(), message: "Must not send", ...input });
    assert.equal(result.code, 1, JSON.stringify(result.value));
    assert.match(result.value.error, pattern);
    assert.equal(writes.length, before);
  };
  await rejected({ subscriptionId: subscription.id, threadId: "other-thread" }, /does not match/);
  await rejected({ eventId: event.id, subscriptionId: other.id }, /different tasks/, mcpReply);
  await rejected({ eventId: event.id, threadId: "other-thread" }, /does not match/, mcpReply);
  await rejected({ threadId: target.threadId }, /require.*project/);
  await rejected({ threadId: target.threadId, projectId: "project-2" }, /projectId/);
  await rejected({ subscriptionId: subscription.id, expectedCwd: path.join(f.dir, "wrong-cwd") }, /cwd/);
  await rejected({ subscriptionId: "missing-task" }, /inactive or missing/);
  const legacy = store.subscribe({ id: "legacy", threadId: target.threadId, supervisor });
  await rejected({ subscriptionId: legacy.id }, /no verified target binding/);

  title = "Renamed App implementation";
  const eventInput = { eventId: event.id, requestId: "event-followup", message: "Proceed with this task" };
  const fromEvent = await mcpReply(eventInput);
  assert.equal(fromEvent.code, 0, JSON.stringify(fromEvent.value));
  assert.equal(fromEvent.value.threadId, target.threadId);
  assert.equal(fromEvent.value.target.title, title);
  assert.equal(fromEvent.value.subscriptionId, subscription.id);
  store.ack({ eventId: event.id, action: "rearm" });
  await rejected({ eventId: event.id }, /already handled/);
  const count = writes.length;
  const replay = await mcpReply(eventInput);
  assert.equal(replay.value.replayed, true, "Completed delivery can be inspected/replayed after event acknowledgment");
  assert.equal(writes.length, count);
  const reads = calls.length;
  const changed = await cliReply({ ...firstInput, threadId: "other-thread" });
  assert.match(changed.value.error, /different input/);
  assert.equal(calls.length, reads, "Changed idempotent input is rejected before desktop inspection");

  cwd = path.join(f.dir, "moved-workspace");
  await rejected({ subscriptionId: subscription.id }, /cwd/);
  cwd = f.dir; projectId = "project-2";
  await rejected({ subscriptionId: subscription.id }, /projectId/);
  projectId = "project-1";
  const standalone = await cliReply({ threadId: target.threadId, projectPath: f.dir, expectedCwd: f.dir, requestId: "standalone", message: "Standalone instruction" });
  assert.equal(standalone.code, 0, JSON.stringify(standalone.value));
  store.ack({ eventId: store.observe(subscription.id, { turnId: "turn-2", turnStatus: "completed", latestMessage: { text: "Finished" } })[0].id, action: "complete" });
  await rejected({ subscriptionId: subscription.id }, /inactive/);

  const transientInput = { subscriptionId: other.id, requestId: "transient-identity", message: "Resume after inspection recovers" };
  identityUnavailable = true;
  const transient = await cliReply(transientInput);
  assert.equal(transient.code, 1);
  assert.equal((await f.cli("delivery", "--request-id", transientInput.requestId)).value.stages.target.phase, "notSent");
  const beforeTransientRetry = writes.length;
  identityUnavailable = false;
  const afterTransient = await cliReply(transientInput);
  assert.equal(afterTransient.code, 0, JSON.stringify(afterTransient.value));
  assert.equal(writes.length, beforeTransientRetry + 1);
  rejectSend = true;
  const uncertainInput = { subscriptionId: other.id, requestId: "uncertain-bound", message: "One dispatch attempt" };
  const uncertain = await cliReply(uncertainInput);
  assert.equal(uncertain.code, 1);
  const attempts = writes.length;
  const retry = await cliReply(uncertainInput);
  assert.match(retry.value.error, /uncertain/);
  assert.equal(writes.length, attempts);
  const uncertainReceipt = (await f.cli("delivery", "--request-id", uncertainInput.requestId)).value;
  assert.equal(uncertainReceipt.stages.instruction.phase, "uncertain");
  assert.equal(uncertainReceipt.stages.target.result.threadId, "other-thread");
});

test("a definitely-unsent bound reply retries the same request once after capacity-error state resumes", async (t) => {
  const f = fixture(t), store = new WatchStore(f.relay), outbox = new ReplyOutbox(f.relay);
  const target = { threadId: "capacity-failed-task", hostId: "local", title: "Existing task", projectId: "project-1", projectPath: f.dir, cwd: f.dir };
  const subscription = store.subscribe({ id: "capacity-recovery", threadId: target.threadId, target,
    supervisor: { host: "codex", threadId: "caller-thread" } });
  const failure = { code: "model_capacity_exhausted", message: "The selected model is temporarily at capacity" };
  const failedTurn = { id: "capacity-turn", status: "failed", error: failure, items: [] };
  const ipcRequests = [], appCalls = [], writes = [];
  let resumeState = "resuming";
  const configFile = path.join(f.codex, "config.toml");
  const config = 'model = "existing-model"\nservice_tier = "default"\n';
  fs.writeFileSync(configFile, config);
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    appCalls.push({ tool, args });
    if (tool === "list_projects") return success({ projects: [{ projectId: target.projectId, path: f.dir }] });
    if (tool === "list_threads") return success({ threads: [{ kind: "codex", id: target.threadId, projectId: target.projectId }] });
    if (tool === "read_thread") return success({ thread: { id: target.threadId, title: target.title, cwd: f.dir, projectId: target.projectId }, turns: [failedTurn] });
    if (tool === "submit_thread") { writes.push(args); return success({ sent: true }); }
    throw new Error(`Unexpected capacity-recovery tool ${tool}`);
  }, { ipcRequests, ipcState: () => ({ resumeState, threadRuntimeStatus: { type: "systemError" },
    turnHistory: { kind: "canonical" }, turns: [failedTurn], latestThreadSettings: { model: "existing-model", serviceTier: "default" } }) });
  const args = { subscriptionId: subscription.id, requestId: "retry-capacity-request", message: "Continue the existing task and run the affected checks." };
  const send = async () => {
    const proc = f.child("mcp.mjs");
    let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_reply", arguments: args } }) + "\n");
    const [code] = await once(proc, "exit"); assert.equal(code, 0);
    const response = JSON.parse(stdout.trim()).result;
    return { isError: Boolean(response.isError), value: JSON.parse(response.content[0].text) };
  };
  const blocked = await send();
  assert.equal(blocked.isError, true); assert.equal(blocked.value.delivery, "notSent");
  assert.equal(outbox.inspect(args.requestId).stages.instruction.phase, "notSent");
  assert.equal(writes.length, 0, "An unsettled snapshot must not dispatch the persisted instruction");
  resumeState = "resumed";
  const recovered = await send();
  assert.equal(recovered.isError, false, JSON.stringify(recovered));
  assert.deepEqual(recovered.value.target, target);
  assert.equal(recovered.value.instructionMethod, "thread-follower-start-turn");
  assert.equal(outbox.inspect(args.requestId).stages.instruction.phase, "delivered");
  assert.deepEqual(writes, [{ threadId: target.threadId, prompt: args.message }]);
  const submissions = ipcRequests.filter((request) => ["thread-follower-start-turn", "thread-follower-steer-turn"].includes(request.method));
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].method, "thread-follower-start-turn");
  assert.deepEqual(submissions[0].params.turnStart.request.input, [{ type: "text", text: args.message, text_elements: [] }]);
  assert.deepEqual(submissions[0].params.turnStart.context, { inheritThreadSettings: true, restoreMessage: {
    id: submissions[0].params.turnStart.request.clientUserMessageId, text: args.message,
    context: { cwd: f.dir, workspaceRoots: [f.dir], collaborationMode: null, commentAttachments: [] },
  } });
  assert.ok(appCalls.every((call) => ["list_projects", "list_threads", "read_thread", "submit_thread"].includes(call.tool)));
  assert.ok(ipcRequests.every((request) => ["initialize", "thread-owner-discovery", "thread-stream-following-changed", "thread-follower-start-turn"].includes(request.method)));
  assert.equal(fs.readFileSync(configFile, "utf8"), config);
  const beforeReplay = ipcRequests.length;
  assert.equal((await send()).value.replayed, true);
  assert.equal(writes.length, 1);
  assert.equal(ipcRequests.length, beforeReplay, "Delivered receipt replay cannot reconnect or resend the task");
});

test("question answers need no provenance flags, never silently degrade, and instructions never answer", async (t) => {
  const f = fixture(t);
  f.env.CODEX_RELAY_IPC_PIPE = f.pipe("absent-ipc");
  const calls = [];
  await mockDesktop(f, (request) => {
    calls.push(request);
    const tool = request.params.tool;
    if (tool === "list_projects") return success({ projects: [{ projectId: "project-1", path: f.dir }] });
    if (tool === "list_threads") return success({ threads: [] });
    if (tool === "read_thread") return success({ thread: { id: "target-thread", cwd: f.dir }, turns: [{ status: "inProgress", items: [{ type: "agentMessage", id: "call_question", text: "Which option?" }] }] });
    if (tool === "submit_thread") return success({ sent: true });
    throw new Error(`Unexpected ${tool}`);
  });
  const input = path.join(f.dir, "reply.json");
  fs.writeFileSync(input, JSON.stringify({ projectPath: f.dir, answers: [{ callId: "call_question", index: 0, text: "Use option A" }] }));
  const result = await f.cli("reply", "target-thread", "--input-file", input);
  assert.equal(result.code, 1);
  assert.equal(result.value.delivery, "notSent");
  assert.ok(calls.some((call) => call.params.tool === "read_thread"), "An answer without source flags reaches the actual delivery path");
  assert.equal(calls.filter((call) => call.params.tool === "submit_thread").length, 0);
  fs.writeFileSync(input, JSON.stringify({ projectPath: f.dir, message: "Inspect the implementation" }));
  f.env.CODEX_RELAY_IPC_PIPE = f.pipe("ipc");
  const instruction = await f.cli("reply", "target-thread", "--input-file", input);
  assert.equal(instruction.value.unansweredQuestions.length, 1);
  assert.equal(fs.existsSync(path.join(f.relay, "answered-calls.json")), false);
});

test("completed write stages recover their receipt after acknowledgment without desktop access", async (t) => {
  const f = fixture(t), store = new WatchStore(f.relay), outbox = new ReplyOutbox(f.relay);
  const target = { threadId: "finished-task", hostId: "local", title: "Finished", projectId: "project-1", projectPath: f.dir, cwd: f.dir };
  const subscription = store.subscribe({ id: "finished-watch", threadId: target.threadId, target, supervisor: { host: "codex", threadId: "caller-thread" } });
  const [event] = store.observe(subscription.id, { turnId: "finished-turn", turnStatus: "completed", latestMessage: { text: "Done" } });
  const input = { eventId: event.id, answers: [{ callId: "already-answered", index: 0, text: "Use the existing implementation" }] };
  await assert.rejects(outbox.execute("finished-reply", input, async (transaction) => {
    await transaction.stage("target", async () => target);
    await transaction.stage("answers", async () => ({ sent: true, via: "codex-ipc", answered: [{ callId: "already-answered", index: 0 }] }));
    throw new Error("Interrupted before final receipt");
  }));
  store.ack({ eventId: event.id, action: "complete" });
  store.remove(subscription.id);
  const file = path.join(f.dir, "recover-receipt.json");
  fs.writeFileSync(file, JSON.stringify({ ...input, requestId: "finished-reply" }));
  const recovered = await f.cli("reply", "--input-file", file);
  assert.equal(recovered.code, 0, JSON.stringify(recovered.value));
  assert.equal(recovered.value.recovered, true);
  assert.deepEqual(recovered.value.target, target);
  const replayed = await f.cli("reply", "--input-file", file);
  assert.equal(replayed.value.replayed, true);
  assert.equal(outbox.inspect("finished-reply").stages.answers.phase, "delivered");
  const unfinished = { ...input, message: "This instruction is still unsent" };
  await assert.rejects(outbox.execute("unfinished-reply", unfinished, async (transaction) => {
    await transaction.stage("target", async () => target);
    await transaction.stage("answers", async () => ({ sent: true, via: "codex-ipc" }));
    await transaction.stage("instruction", async () => { throw Object.assign(new Error("Not dispatched"), { delivery: "notSent" }); });
  }));
  fs.writeFileSync(file, JSON.stringify({ ...unfinished, requestId: "unfinished-reply" }));
  const blocked = await f.cli("reply", "--input-file", file);
  assert.equal(blocked.code, 1);
  assert.match(blocked.value.error, /already handled/);
  assert.equal(outbox.inspect("unfinished-reply").stages.instruction.phase, "notSent");
});

test("legacy replies resume only outstanding stages with the original repaired target binding", async (t) => {
  const f = fixture(t), store = new WatchStore(f.relay), outbox = new ReplyOutbox(f.relay), sent = [];
  const target = { threadId: "legacy-task", hostId: "local", title: "Legacy task", projectId: "project-1", projectPath: f.dir, cwd: f.dir };
  const subscription = store.subscribe({ id: "legacy-retry-watch", threadId: target.threadId, supervisor: { host: "codex", threadId: "caller-thread" } });
  const input = { threadId: target.threadId, answers: [{ callId: "already-answered", index: 0, text: "Keep the interface" }], message: "Continue remaining work" };
  await assert.rejects(outbox.execute("legacy-partial", input, async (transaction) => {
    await transaction.stage("answers", async () => ({ sent: true, via: "codex-ipc", answered: [{ callId: "already-answered", index: 0 }] }));
    await transaction.stage("instruction", async () => { throw Object.assign(new Error("Rejected before send"), { delivery: "notSent" }); });
  }));
  const receiptFile = path.join(f.relay, "outgoing", `${crypto.createHash("sha256").update("legacy-partial").digest("hex")}.json`);
  const releasedReceipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")); delete releasedReceipt.schemaVersion;
  fs.writeFileSync(receiptFile, JSON.stringify(releasedReceipt));
  const file = path.join(f.dir, "legacy-partial.json");
  fs.writeFileSync(file, JSON.stringify({ ...input, requestId: "legacy-partial" }));
  const unbound = await f.cli("reply", "--input-file", file);
  assert.equal(unbound.code, 1);
  assert.match(unbound.value.error, /verified target binding/);
  store.bindTarget(subscription.id, target);
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    if (tool === "list_projects") return success({ projects: [{ projectId: "project-1", path: f.dir }] });
    if (tool === "list_threads") return success({ threads: [] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, cwd: f.dir }, turns: [] });
    if (tool === "submit_thread") { sent.push(args); return success({ sent: true }); }
    throw new Error(`Unexpected legacy retry tool ${tool}`);
  });
  const resumed = await f.cli("reply", "--input-file", file);
  assert.equal(resumed.code, 0, JSON.stringify(resumed.value));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, target.threadId);
  assert.equal(sent[0].prompt, input.message);
  assert.equal(resumed.value.answered[0].callId, "already-answered");
  assert.equal(outbox.inspect("legacy-partial").legacyReplyThreadId, target.threadId);
});

test("an explicit selector cannot bypass repaired binding requirements for incomplete legacy replies", async (t) => {
  const f = fixture(t), store = new WatchStore(f.relay), outbox = new ReplyOutbox(f.relay), sent = [];
  const target = { threadId: "legacy-explicit", hostId: "local", title: "Legacy", projectId: "project-1", projectPath: f.dir, cwd: f.dir };
  const subscription = store.subscribe({ id: "explicit-retry", threadId: target.threadId, supervisor: { host: "codex", threadId: "caller-thread" } });
  const input = { threadId: target.threadId, projectPath: f.dir, message: "Continue" };
  await assert.rejects(outbox.execute("legacy-explicit", input, async (tx) => {
    await tx.stage("instruction", async () => { throw Object.assign(new Error("Not sent"), { delivery: "notSent" }); });
  }));
  const receiptFile = path.join(f.relay, "outgoing", `${crypto.createHash("sha256").update("legacy-explicit").digest("hex")}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")); delete receipt.schemaVersion;
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const file = path.join(f.dir, "explicit-retry.json");
  fs.writeFileSync(file, JSON.stringify({ ...input, requestId: "legacy-explicit" }));
  const blocked = await f.cli("reply", "--input-file", file);
  assert.equal(blocked.code, 1);
  assert.match(blocked.value.error, /verified target binding/);
  store.bindTarget(subscription.id, target);
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    if (tool === "list_projects") return success({ projects: [] });
    if (tool === "list_threads") return success({ threads: [] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, cwd: f.dir }, turns: [] });
    if (tool === "submit_thread") { sent.push(args); return success({ sent: true }); }
    throw new Error(`Unexpected legacy-explicit tool ${tool}`);
  });
  const resumed = await f.cli("reply", "--input-file", file);
  assert.equal(resumed.code, 0, JSON.stringify(resumed.value));
  assert.equal(resumed.value.target.threadId, target.threadId);
  assert.equal(sent.length, 1);
});

test("an explicit-project legacy event reply binds its original subscription without re-registering it", async (t) => {
  const f = fixture(t), store = new WatchStore(f.relay), sent = [];
  const subscription = store.subscribe({ id: "legacy-direct", threadId: "shared-task", supervisor: { host: "codex", threadId: "caller-thread" },
    goal: { task: "Implement shared contract", doneWhen: "Checks pass" }, policy: { noFast: true } });
  const [event] = store.observe(subscription.id, { turnId: "original", turnStatus: "completed", latestMessage: { text: "Review this" } });
  const before = store.get(subscription.id);
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    if (tool === "list_projects") return success({ projects: [] });
    if (tool === "list_threads") return success({ threads: [{ kind: "codex", id: "shared-task", projectId: "shared-project" }] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, cwd: f.dir }, turns: [] });
    if (tool === "submit_thread") { sent.push(args); return success({ sent: true }); }
    throw new Error(`Unexpected legacy direct tool ${tool}`);
  });
  const file = path.join(f.dir, "legacy-direct.json");
  fs.writeFileSync(file, JSON.stringify({ eventId: event.id, projectId: "shared-project", expectedCwd: f.dir, message: "Continue shared contract", requestId: "legacy-direct-reply" }));
  const result = await f.cli("reply", "--input-file", file);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(sent.length, 1);
  const after = store.get(subscription.id);
  assert.deepEqual({ ...after, target: undefined }, { ...before, target: undefined });
  assert.equal(after.target.projectId, "shared-project");
  assert.equal(store.events()[0].id, event.id);
});

test("watch registration upgrades a legacy binding in place and scoped event replies use that recipient", { timeout: 15_000 }, async (t) => {
  const f = fixture(t), sends = [];
  f.env.CODEX_RELAY_DAEMON_PIPE = f.pipe("binding-service");
  const store = new WatchStore(f.relay);
  const supervisor = { host: "codex", threadId: "caller-thread" };
  const legacy = store.subscribe({ id: "existing-watch", threadId: "watched", supervisor });
  const [event] = store.observe(legacy.id, { turnId: "legacy-turn", turnStatus: "completed", latestMessage: { text: "Legacy event" } });
  let omit = false;
  const cwd = path.join(f.dir, "worktree");
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    if (tool === "list_projects") return success({ projects: omit ? [] : [{ projectId: "project-1", path: f.dir }] });
    if (tool === "list_threads") return success({ threads: omit ? [] : [{ kind: "codex", id: "watched", projectId: "project-1", title: "Watched" }] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, title: "Watched", cwd }, turns: [] });
    if (tool === "submit_thread") { sends.push(args); return success({ sent: true }); }
    if (tool === "wait_threads") return success({ polls: [] });
    throw new Error(`Unexpected legacy-binding tool ${tool}`);
  });
  const file = path.join(f.dir, "register.json");
  const register = async (input) => { fs.writeFileSync(file, JSON.stringify(input)); return f.cli("watch", "--input-file", file); };
  const missing = await register({ id: legacy.id, threadId: legacy.threadId, supervisor });
  assert.equal(missing.code, 1);
  assert.match(missing.value.error, /requires.*project/);
  const bound = await register({ id: legacy.id, threadId: legacy.threadId, supervisor, projectPath: f.dir });
  assert.equal(bound.code, 0, JSON.stringify(bound.value));
  assert.equal(bound.value.id, legacy.id);
  assert.equal(bound.value.target.projectId, "project-1");
  assert.equal(store.events()[0].id, event.id, "Binding preserves the original pending event");
  omit = true;
  store.subscribe({ id: legacy.id, threadId: legacy.threadId, supervisor, enabled: false });
  const registered = await register({ id: legacy.id, threadId: legacy.threadId, supervisor, projectPath: f.dir });
  assert.equal(registered.code, 0, JSON.stringify(registered.value));
  assert.equal(registered.value.enabled, false, "Re-registration preserves inactive state");
  assert.equal(registered.value.target.cwd, cwd);
  const resumed = await register({ id: legacy.id, threadId: legacy.threadId, supervisor, projectId: "project-1", enabled: true });
  assert.equal(resumed.code, 0, JSON.stringify(resumed.value));
  assert.equal(resumed.value.enabled, true);
  assert.equal(store.events()[0].id, event.id);
  Object.assign(f.env, { CODEX_RELAY_WAKE_EVENT_ID: event.id, CODEX_RELAY_WAKE_SUBSCRIPTION_ID: legacy.id, CODEX_RELAY_WAKE_THREAD_ID: legacy.threadId });
  const proc = f.child("mcp.mjs");
  let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_reply", arguments: { eventId: event.id, message: "Continue the watched task" } } }) + "\n");
  await once(proc, "exit");
  const response = JSON.parse(stdout.trim()).result;
  assert.ok(!response.isError, JSON.stringify(response));
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.eventId, event.id);
  assert.equal(result.target.threadId, legacy.threadId);
  const instructions = sends.filter((entry) => entry.prompt === "Continue the watched task");
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].threadId, legacy.threadId);
});

test("MCP discovers common tools and rejects invalid inputs without touching desktop", async (t) => {
  const f = fixture(t);
  const proc = f.child("mcp.mjs");
  let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_start", arguments: { prompt: 42 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "codex_threads", arguments: { limit: 100 } } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const [code] = await once(proc, "exit"); assert.equal(code, 0);
  const responses = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.find((response) => response.id === 1).result.serverInfo.name, "codex-relay");
  const names = responses.find((response) => response.id === 2).result.tools.map((tool) => tool.name);
  for (const name of ["codex_reply", "codex_watch", "codex_events", "codex_event_context", "codex_event_report", "codex_watch_ack", "codex_supervise", "codex_preflight", "codex_host"]) assert.ok(names.includes(name));
  assert.equal(responses.find((response) => response.id === 3).result.isError, true);
  const oversized = responses.find((response) => response.id === 4).result;
  assert.equal(oversized.isError, true);
  assert.match(JSON.parse(oversized.content[0].text).error, /limit.*allowed range/);
});

test("MCP composite creates one execution and persists its acceptance condition in the real isolated service", { timeout: 15_000 }, async (t) => {
  const f = fixture(t), calls = [];
  f.env.CODEX_RELAY_DAEMON_PIPE = f.pipe("watch-service");
  fs.writeFileSync(path.join(f.codex, "config.toml"), 'service_tier = "default"\n');
  await mockDesktop(f, (request) => {
    const { tool, arguments: args } = request.params;
    calls.push({ tool, args });
    if (tool === "list_projects") return success({ projects: [{ projectId: "project-1", path: f.dir }] });
    if (tool === "list_threads") return success({ threads: [{ kind: "codex", id: "caller-thread", projectId: "project-1", status: "idle" }] });
    if (tool === "read_thread") return success({ thread: { id: args.threadId, cwd: f.dir }, turns: [] });
    if (tool === "create_thread") return success({ threadId: "execution-workflow" });
    if (tool === "wait_threads") return success({ polls: [{ thread: { id: "execution-workflow", status: { type: "active" } }, latestTurn: { id: "turn-1", status: "inProgress" } }] });
    throw new Error(`Unexpected workflow tool ${tool}`);
  }, { ipc: false });
  let settingsReads = 0;
  const submitted = [];
  const ipc = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const send = (value) => {
        const bytes = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(bytes.length + 4);
        frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); socket.write(frame);
      };
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        const respond = (result) => send({ type: "response", requestId: message.requestId, ...result });
        if (message.method === "initialize") respond({ resultType: "success", result: { clientId: "reader-1" } });
        else if (message.method === "thread-owner-discovery") respond({ resultType: "success", handledByClientId: "owner-1" });
        else if (message.method === "thread-follower-read-model-settings") respond({ resultType: "success", method: message.method,
          handledByClientId: "owner-1", result: { settings: { resumeState: "resumed" } } });
        else if (message.method === "thread-stream-following-changed") {
          if (!message.params.following) continue;
          settingsReads++;
          send({ type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "owner-1", version: 11,
            params: { hostId: "local", conversationId: message.params.conversationId, change: { type: "snapshot", revision: 1,
              conversationState: { id: message.params.conversationId, hostId: "local", resumeState: "resumed", threadRuntimeStatus: { type: "idle" },
                latestThreadSettings: { serviceTier: "default" } } } } });
        } else if (message.method === "thread-follower-start-turn") {
          submitted.push(message.params);
          respond({ resultType: "success", method: message.method, handledByClientId: "owner-1", result: { result: { turn: { id: "accepted-turn", status: "inProgress" } } } });
        } else assert.fail(`Unexpected workflow IPC ${message.method}`);
      }
    });
  });
  f.servers.push(ipc); ipc.listen(f.env.CODEX_RELAY_IPC_PIPE); await once(ipc, "listening");
  const proc = f.child("mcp.mjs"), pending = new Map();
  let buffer = "", sequence = 0;
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (part) => {
    buffer += part;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result); pending.delete(message.id);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP workflow response timed out")); }, 10_000);
    pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", { clientInfo: { name: "isolated-test", version: "1" } });
  const args = { requestId: "workflow-test", createNew: true, projectPath: f.dir,
    supervisor: { host: "codex", threadId: "caller-thread", cwd: f.dir, mode: "desktop" },
    task: "Fix the regression", doneWhen: "The regression check passes" };
  const first = await request("tools/call", { name: "codex_supervise", arguments: args });
  assert.ok(!first.isError, JSON.stringify(first));
  const result = JSON.parse(first.content[0].text);
  assert.equal(result.status, "watching", JSON.stringify(result));
  assert.equal(result.requestId, args.requestId);
  const state = JSON.parse(fs.readFileSync(path.join(f.relay, "watches", "state.json"), "utf8"));
  const stored = state.subscriptions[result.subscriptionId];
  assert.equal(stored.supervisor.threadId, "caller-thread");
  assert.equal(stored.threadId, "execution-workflow");
  assert.deepEqual(stored.goal, { task: args.task, doneWhen: args.doneWhen });
  assert.equal(stored.policy.noFast, true);
  const created = calls.find((call) => call.tool === "create_thread");
  assert.equal(created.args.prompt, `${args.task}\n\n${args.doneWhen}`);
  assert.equal(created.args.model, undefined);
  assert.equal(created.args.thinking, undefined);
  const again = await request("tools/call", { name: "codex_supervise", arguments: args });
  assert.equal(JSON.parse(again.content[0].text).replayed, true);
  assert.equal(calls.filter((call) => call.tool === "create_thread").length, 1);
  assert.equal(calls.filter((call) => call.tool === "submit_thread").length, 0);
  assert.equal(settingsReads, 2, "Setup verifies both sessions; receipt replay does not repeat setup");
  assert.equal(submitted.length, 0, "The native creation already submitted the task; ordinary input cannot send it a second time");
});

test("CLI and MCP deliver verbatim answers and instructions with optional source metadata and deduplication", async (t) => {
  const f = fixture(t);
  f.env.CODEX_RELAY_IPC_PIPE = f.pipe("ipc");
  const project = path.join(f.dir, "app"), library = path.join(f.dir, "shared-library");
  fs.mkdirSync(project); fs.mkdirSync(library);
  const configFile = path.join(f.codex, "config.toml");
  const config = 'service_tier = "default"\nsandbox_mode = "workspace-write"\n';
  fs.writeFileSync(configFile, config);
  const store = new WatchStore(f.relay);
  const target = { threadId: "target-thread", hostId: "local", title: "Application work", projectId: "project-1", projectPath: project, cwd: project };
  const subscription = store.subscribe({ id: "application-task", threadId: target.threadId, target,
    supervisor: { host: "codex", threadId: "caller-thread" } });
  const messages = [], instructions = [], instructionInputs = [], appCalls = [], ipcCalls = [];
  let callId;
  await mockDesktop(f, (request) => {
    const tool = request.params.tool;
    appCalls.push({ tool, args: request.params.arguments });
    if (tool === "list_projects") return success({ projects: [{ projectId: "project-1", path: project }] });
    if (tool === "list_threads") return success({ threads: [] });
    if (tool === "read_thread") return success({ thread: { id: "target-thread", title: target.title, cwd: project }, turns: [{ status: "inProgress", items: [{ type: "agentMessage", id: callId, text: "Which implementation?" }] }] });
    if (tool === "submit_thread") { instructions.push(request.params.arguments.prompt); return success({ sent: true }); }
    throw new Error(`Unexpected ${tool}`);
  }, { ipc: false });
  const ipc = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        ipcCalls.push(request);
        const send = (value) => {
          const payload = Buffer.from(JSON.stringify(value));
          const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
        };
        if (request.method === "thread-stream-following-changed") {
          if (request.params.following) send({ type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "window-1", version: 11,
            params: { hostId: "local", conversationId: request.params.conversationId, change: { type: "snapshot", revision: 1,
              conversationState: { id: request.params.conversationId, hostId: "local", resumeState: "resumed", threadRuntimeStatus: { type: "idle" } } } } });
          continue;
        }
        if (request.type !== "request") continue;
        let result;
        if (request.method === "initialize") result = { resultType: "success", result: { clientId: "relay-client" } };
        else if (request.method === "thread-owner-discovery") result = { resultType: "success", handledByClientId: "window-1" };
        else if (request.method === "thread-follower-start-turn") {
          instructionInputs.push(request.params);
          instructions.push(request.params.turnStart.request.input[0].text);
          result = { resultType: "success", result: { result: { turn: { id: "accepted-turn", status: "inProgress" } } } };
        }
        else if (request.method === "thread-follower-steer-turn") { messages.push(request.params); result = { resultType: "success", result: { result: { turnId: "running-turn" } } }; }
        else throw new Error(`Unexpected IPC ${request.method}`);
        send({ type: "response", requestId: request.requestId, method: request.method, handledByClientId: "window-1", ...result });
      }
    });
  });
  f.servers.push(ipc); ipc.listen(f.pipe("ipc")); await once(ipc, "listening");
  const file = path.join(f.dir, "reply.json");
  const mcpReply = async (args) => {
    const proc = f.child("mcp.mjs");
    let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_reply", arguments: args } }) + "\n");
    const [code] = await once(proc, "exit"); assert.equal(code, 0);
    const result = JSON.parse(stdout.trim()).result;
    assert.ok(!result.isError, JSON.stringify(result));
    return { code, value: JSON.parse(result.content[0].text) };
  };
  const variants = [{}, { answerSource: "agent" }, { answerSource: "user" }, { userProvided: true }];
  for (const [index, metadata] of variants.entries()) {
    callId = `call_routine_${index}`;
    const answer = "I choose the existing adapter.\nKeep its current interface.";
    const message = "I reviewed the result. Continue with the agreed checks.\n";
    const args = { threadId: "target-thread", projectPath: project, requestId: `event-routine:reply-${index}`, ...metadata,
      answers: [{ callId, index: 0, text: answer }], message };
    const { threadId, ...input } = args;
    fs.writeFileSync(file, JSON.stringify(input));
    const send = () => index % 2 ? mcpReply(args) : f.cli("reply", "target-thread", "--input-file", file);
    const first = await send();
    assert.equal(first.code, 0, JSON.stringify(first.value));
    assert.equal(first.value.answerSource, metadata.answerSource ?? (metadata.userProvided ? "user" : "agent"));
    const second = await send();
    assert.equal(second.value.replayed, true);
    assert.equal(messages.length, index + 1); assert.equal(instructions.length, index + 1);
    const reply = messages[index].input[0].text;
    const answers = JSON.parse(reply.slice(reply.indexOf("\n") + 1, reply.lastIndexOf("\n")));
    assert.equal(answers[0].answer, answer);
    assert.equal(instructions[index], message);
    assert.match(messages[index].clientUserMessageId, /^[a-f0-9-]{36}$/);
  }
  const message = `Update the shared adapter in ${library}.\nKeep the application integration working and run the affected checks.`;
  const reply = { subscriptionId: subscription.id, requestId: "cross-directory-work", message };
  const first = await mcpReply(reply);
  assert.deepEqual(first.value.target, target);
  assert.equal(first.value.subscriptionId, subscription.id);
  assert.equal(instructions.at(-1), message, "The execution message contains only the direct work instruction");
  const submitted = instructionInputs.at(-1);
  assert.equal(submitted.conversationId, target.threadId);
  assert.deepEqual(submitted.turnStart.request.input, [{ type: "text", text: message, text_elements: [] }]);
  assert.deepEqual(submitted.turnStart.context, { inheritThreadSettings: true, restoreMessage: {
    id: submitted.turnStart.request.clientUserMessageId, text: message,
    context: { cwd: project, workspaceRoots: [project], collaborationMode: null, commentAttachments: [] },
  } });
  assert.deepEqual(store.get(subscription.id).target, target, "Cross-directory work keeps the original recipient binding");
  assert.equal(fs.readFileSync(configFile, "utf8"), config, "Delivery does not rewrite permission or model settings");
  assert.ok(appCalls.every((call) => ["list_projects", "list_threads", "read_thread"].includes(call.tool)));
  assert.ok(appCalls.filter((call) => call.tool === "read_thread").every((call) => call.args.threadId === target.threadId));
  assert.equal(JSON.stringify(appCalls).includes(library), false, "The library path is task content, never a project selector");
  assert.ok(ipcCalls.every((call) => ["initialize", "thread-owner-discovery", "thread-stream-following-changed",
    "thread-follower-start-turn", "thread-follower-steer-turn"].includes(call.method)), "Only input delivery uses the desktop protocol");
  const count = instructionInputs.length;
  assert.equal((await mcpReply(reply)).value.replayed, true);
  assert.equal(instructionInputs.length, count, "Replaying the bound instruction cannot send it twice");
});

test("event CLI reads compact current state, pages original reports and rearms without echoing snapshots", async (t) => {
  const f = fixture(t), calls = [];
  const store = new WatchStore(f.relay);
  const watch = store.subscribe({ threadId: "watched", supervisor: { host: "codex", threadId: "caller-thread" },
    goal: { task: "Fix the regression", doneWhen: "Regression tests pass" } });
  const report = "Original event report. ".repeat(1000) + "REPORT-END";
  const [event] = store.observe(watch.id, { turnId: "original-turn", turnStatus: "completed", latestMessage: { phase: "final_answer", text: report } });
  Object.assign(f.env, { CODEX_RELAY_WAKE_EVENT_ID: event.id, CODEX_RELAY_WAKE_SUBSCRIPTION_ID: watch.id, CODEX_RELAY_WAKE_THREAD_ID: "watched" });
  await mockDesktop(f, (request) => {
    const { tool } = request.params; calls.push(tool);
    if (tool === "list_threads") return success({ threads: [] });
    if (tool === "wait_threads") return success({ polls: [{ thread: { id: "watched", status: { type: "idle" } },
      latestTurn: { id: "newer-turn", status: "completed" }, latestAssistantMessage: { phase: "final_answer", text: "Current result. ".repeat(500) } }] });
    if (tool === "read_thread") return success({ thread: { id: "watched" }, turns: [
      { id: "newer-turn", items: [{ type: "agentMessage", text: "Unrelated newer report" }] },
      { id: "original-turn", items: [{ type: "agentMessage", text: report }] },
    ] });
    throw new Error(`Unexpected event tool ${tool}`);
  });
  const input = path.join(f.dir, "event-input.json");
  const run = (command, args) => { fs.writeFileSync(input, JSON.stringify(args)); return f.cli(command, "--input-file", input); };
  const context = await run("event-context", { eventId: event.id });
  assert.equal(context.code, 0, JSON.stringify(context.value));
  assert.equal(context.value.stale, true);
  assert.equal(context.value.goal.doneWhen, "Regression tests pass");
  assert.equal(context.value.current.latestMessage.text.length, 400);
  assert.equal(context.value.eventPreview.latestMessage.text.length, 400);
  assert.equal(JSON.stringify(context.value).includes("REPORT-END"), false);
  assert.equal(calls.filter((name) => name === "read_thread").length, 0, "A context read does not request the full report");
  const page = await run("event-report", { eventId: event.id, limit: 256 });
  assert.equal(page.value.text, report.slice(0, 256));
  assert.equal(page.value.complete, true);
  assert.equal(page.value.turnId, "original-turn");
  const finalPage = await run("event-report", { eventId: event.id, offset: report.length - 10, reportHash: page.value.reportHash });
  assert.equal(finalPage.value.text, "REPORT-END");
  const ack = await run("ack", { eventId: event.id, action: "rearm" });
  assert.equal(ack.value.phase, "acknowledged");
  assert.equal(Object.hasOwn(ack.value, "payload"), false);
  assert.ok(JSON.stringify(ack.value).length < 500);
  const previousCalls = calls.length;
  const handled = await run("event-context", { eventId: event.id });
  assert.equal(handled.value.handled, true);
  assert.equal(handled.value.nextAction, "skip");
  assert.equal(calls.length, previousCalls, "Acknowledged events do not requery the desktop after process restart");
  assert.equal(store.list()[0].enabled, true);
  assert.equal(store.observe(watch.id, { turnId: "next-turn", turnStatus: "completed", latestMessage: { text: "Next result" } }).length, 1);
});

test("scoped MCP wake workers reject other threads and unsolicited tools", async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { CODEX_RELAY_WAKE_EVENT_ID: "event-1", CODEX_RELAY_WAKE_SUBSCRIPTION_ID: "watch-1", CODEX_RELAY_WAKE_THREAD_ID: "watched" });
  const proc = f.child("mcp.mjs");
  let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stdin.end([
    { id: 1, method: "tools/list" },
    { id: 2, method: "tools/call", params: { name: "codex_status", arguments: { threadId: "unrelated" } } },
    { id: 3, method: "tools/call", params: { name: "codex_start", arguments: { prompt: "Unsolicited task" } } },
    { id: 4, method: "tools/call", params: { name: "codex_event_context", arguments: { eventId: "another-event" } } },
    { id: 5, method: "tools/call", params: { name: "codex_event_report", arguments: { eventId: "another-event" } } },
  ].map(JSON.stringify).join("\n") + "\n");
  const [code] = await once(proc, "exit"); assert.equal(code, 0);
  const replies = stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(replies.find((r) => r.id === 1).result.tools.map((tool) => tool.name).sort(), ["codex_delivery", "codex_event_context", "codex_event_report", "codex_events", "codex_reply", "codex_status", "codex_watch_ack"]);
  assert.equal(replies.find((r) => r.id === 2).result.isError, true);
  assert.equal(replies.find((r) => r.id === 3).result.isError, true);
  assert.equal(replies.find((r) => r.id === 4).result.isError, true);
  assert.equal(replies.find((r) => r.id === 5).result.isError, true);
});

test("cancelling a long poll releases its socket so a background wait can finish promptly", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.relay, "token"), "test-token");
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(f.pipe("control")); await once(server, "listening");
  const code = `const {relay}=await import(${JSON.stringify(new URL("../src/desktop/transport.mjs", import.meta.url).href)});const c=new AbortController();setTimeout(()=>c.abort(),50);try{await relay('tools/call',{}, {signal:c.signal});process.exitCode=1}catch(e){console.log(JSON.stringify({error:e.message}))}`;
  const proc = spawn(runtime, ["--input-type=module", "-e", code], { env: f.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
  const timeout = setTimeout(() => proc.kill(), 3_000);
  try {
    const [exit] = await once(proc, "exit");
    assert.equal(exit, 0);
    assert.match(JSON.parse(stdout.trim()).error, /cancelled/);
  } finally {
    clearTimeout(timeout);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bridge requires app context and rejects unauthenticated or non-workflow tool calls", async (t) => {
  const f = fixture(t);
  let appCalls = 0;
  await mockDesktop(f, () => { appCalls++; return success({}); });
  const request = (payload) => new Promise((resolve, reject) => {
    const socket = net.createConnection(f.pipe("control"));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.once("data", (chunk) => { socket.destroy(); resolve(JSON.parse(chunk)); });
  });
  const token = fs.readFileSync(path.join(f.relay, "token"), "utf8").trim();
  assert.match((await request({ id: 1, token: "invalid", method: "relay/info" })).error.message, /invalid token/);
  assert.match((await request({ id: 2, token, method: "tools/call", params: { tool: "delete_project", threadId: "caller-thread" } })).error.message, /not allowed/);
  assert.equal(appCalls, 0);
  const info = await f.cli("info"); assert.equal(info.value.appPipe, true);
});

// The desktop error some versions return for every externally relayed wait_threads call.
const appToolFailure = { appError: { code: -32000, message: "Codex app tool request failed" } };

test("status and wait fall back to read_thread when the desktop rejects wait_threads", async (t) => {
  const f = fixture(t);
  let turn = { id: "turn-2", status: "inProgress", items: [
    { type: "commandExecution", id: "cmd", command: "flutter test", status: "completed" },
    { type: "agentMessage", id: "call_q1", text: "Which layout?", phase: "final_answer" },
  ] };
  const calls = [];
  await mockDesktop(f, (request) => {
    const { tool } = request.params;
    calls.push(tool);
    if (tool === "wait_threads") return appToolFailure;
    if (tool === "read_thread") return success({ thread: { id: "target-thread", cwd: f.dir, status: { type: "active", activeFlags: [] } }, turns: [turn] });
    if (tool === "list_threads") return success({ threads: [] });
    throw new Error(`Unexpected tool ${tool}`);
  });
  const status = (await f.cli("status", "target-thread")).value;
  assert.equal(status.source, "read_thread");
  assert.equal(status.turnStatus, "inProgress");
  assert.equal(status.latestMessage.phase, "question");
  assert.deepEqual(status.questions, [{ callId: "call_q1", index: 0, question: "Which layout?" }]);
  assert.equal(calls.filter((tool) => tool === "read_thread").length, 1, "one compact read serves status, questions, and attention");
  turn = { id: "turn-2", status: "completed", items: [{ type: "agentMessage", id: "final", text: "Done", phase: "final_answer" }] };
  const waited = (await f.cli("wait", "target-thread", "--timeout-minutes", "1")).value;
  assert.equal(waited.reason, "turnEnded");
  assert.equal(waited.latestMessage.text, "Done");
  assert.equal(calls.filter((tool) => tool === "wait_threads").length, 2, "each process tries wait_threads once, then stops");
});

test("a turn too large for read_thread is read from a bounded tail of the session log", async (t) => {
  const f = fixture(t);
  await mockDesktop(f, (request) => {
    const { tool } = request.params;
    if (tool === "wait_threads") return appToolFailure;
    if (tool === "read_thread") return { success: false, contentItems: [{ type: "text", text: "Thread read exceeds the size limit" }] };
    if (tool === "list_threads") return success({ threads: [] });
    throw new Error(`Unexpected tool ${tool}`);
  });
  const day = path.join(f.codex, "sessions", "2026", "10", "20");
  fs.mkdirSync(day, { recursive: true });
  const log = path.join(day, "rollout-2026-10-20T00-00-00-target-thread.jsonl");
  const line = (type, payload) => `${JSON.stringify({ timestamp: "2026-10-20T00:00:00Z", type, payload })}\n`;
  const event = (payload) => line("event_msg", payload);
  const item = (turnId, item) => event({ type: "item_completed", turn_id: turnId, item });
  // An earlier turn with filler spanning several read chunks, so the scan must cross chunk boundaries.
  let text = event({ type: "task_started", turn_id: "old" });
  const filler = item("old", { type: "CommandExecution", id: "cmd", aggregated_output: "x".repeat(4000) });
  text += filler.repeat(Math.ceil(3 * 1024 * 1024 / filler.length));
  text += event({ type: "task_complete", turn_id: "old", last_agent_message: "Old answer" });
  text += event({ type: "task_started", turn_id: "new" });
  text += line("turn_context", { turn_id: "new", cwd: f.dir });
  text += item("new", { type: "AgentMessage", id: "msg", content: [{ text: "Working" }], phase: "commentary" });
  text += line("response_item", { type: "function_call", name: "request_user_input_async", call_id: "call_q2",
    arguments: JSON.stringify({ questions: [{ title: "First?" }, { title: "Second?" }] }) });
  text += item("new", { type: "AgentMessage", id: "call_q2", content: [{ text: "First? Second?" }], phase: "final_answer" });
  fs.writeFileSync(log, text);
  const first = (await f.cli("status", "target-thread")).value;
  assert.equal(first.source, "rollout");
  assert.equal(first.turnId, "new");
  assert.equal(first.turnStatus, "inProgress");
  assert.deepEqual(first.questions.map((entry) => entry.question), ["First?", "Second?"]);
  const reply = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "call_q2", 0]), answer: "A" }])}\n</send_user_message_question_reply>`;
  fs.appendFileSync(log, item("new", { type: "UserMessage", id: "u", content: [{ text: reply }] }));
  assert.deepEqual((await f.cli("status", "target-thread")).value.questions.map((entry) => entry.index), [1]);
  fs.appendFileSync(log, event({ type: "task_complete", turn_id: "new", last_agent_message: "Finished the new turn" }));
  const ended = (await f.cli("wait", "target-thread", "--timeout-minutes", "1")).value;
  assert.equal(ended.reason, "turnEnded");
  assert.equal(ended.latestMessage.text, "Finished the new turn");
  assert.equal(ended.questions, undefined);
});
