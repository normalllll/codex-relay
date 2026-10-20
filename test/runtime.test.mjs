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
  const env = { ...process.env, CODEX_RELAY_HOME: relay, CODEX_HOME: codex, CODEX_RELAY_PIPE: pipe("control"), CODEX_APP_TOOLS_PIPE_PATH: pipe("app"), CODEX_THREAD_ID: "caller-thread" };
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

async function mockDesktop(f, handler) {
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
        const result = handler(request);
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
  f.child("relay-server.mjs");
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(f.relay, "relay.log")) && fs.readFileSync(path.join(f.relay, "relay.log"), "utf8").includes("listening")) return;
    await pause(20);
  }
  throw new Error("Test bridge did not start");
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
  const proc = spawnSync(runtime, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(new URL("../codex-client.mjs", import.meta.url).href)}); console.log(JSON.stringify({file:m.discoverStateDatabase(),ids:m.recentThreadIds()}))`], { env: f.env, encoding: "utf8", windowsHide: true });
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
    if (tool === "read_thread") return success({ turns: [] });
    if (tool === "send_message_to_thread") return success({ sent: true });
    throw new Error(`Unexpected tool ${tool}`);
  });
  assert.deepEqual((await f.cli("projects")).value, [{ projectId: "project-1", label: "Example", path: f.dir }]);
  const prompt = path.join(f.dir, "prompt.txt"); fs.writeFileSync(prompt, "Do the authorized task");
  assert.equal((await f.cli("start", "--project", f.dir, "--prompt-file", prompt)).value.threadId, "target-thread");
  const pending = await f.cli("start", "--project", f.dir, "--prompt-file", prompt, "--worktree");
  assert.equal(pending.value.status, "pending");
  assert.equal((await f.cli("resolve", pending.value.pendingClientThreadId)).value.threadId, "worktree-thread");
  assert.equal((await f.cli("status", "target-thread")).value.latestMessage.text, "Finished");
  assert.equal((await f.cli("wait", "target-thread", "--timeout-minutes", "0")).value.reason, "turnEnded");
  const input = path.join(f.dir, "reply.json"); fs.writeFileSync(input, JSON.stringify({ message: "Summarize" }));
  assert.equal((await f.cli("reply", "target-thread", "--input-file", input)).value.sent, true);
  const instruction = calls.findLast((call) => call.params.tool === "send_message_to_thread");
  assert.equal(instruction.params.arguments.prompt, "[Delegated instruction via Codex Relay]\nSummarize");
  const before = calls.length;
  assert.equal((await f.cli("wait", "target-thread", "--timeout-minutes", "NaN")).code, 1);
  assert.equal(calls.length, before, "Invalid inputs must fail before desktop calls");
});

test("question answers require provenance, never silently degrade, and instructions never answer", async (t) => {
  const f = fixture(t);
  f.env.CODEX_RELAY_IPC_PIPE = f.pipe("absent-ipc");
  const calls = [];
  await mockDesktop(f, (request) => {
    calls.push(request);
    const tool = request.params.tool;
    if (tool === "list_threads") return success({ threads: [] });
    if (tool === "read_thread") return success({ turns: [{ status: "inProgress", items: [{ type: "agentMessage", id: "call_question", text: "Which option?" }] }] });
    if (tool === "send_message_to_thread") return success({ sent: true });
    throw new Error(`Unexpected ${tool}`);
  });
  const input = path.join(f.dir, "reply.json");
  fs.writeFileSync(input, JSON.stringify({ answers: [{ callId: "call_question", index: 0, text: "Use option A" }] }));
  assert.equal((await f.cli("reply", "target-thread", "--input-file", input)).code, 1);
  assert.equal(calls.length, 0);
  const result = await f.cli("reply", "target-thread", "--input-file", input, "--user-provided");
  assert.equal(result.code, 1);
  assert.equal(result.value.delivery, "notSent");
  assert.equal(calls.filter((call) => call.params.tool === "send_message_to_thread").length, 0);
  fs.writeFileSync(input, JSON.stringify({ message: "Inspect the implementation" }));
  const instruction = await f.cli("reply", "target-thread", "--input-file", input);
  assert.equal(instruction.value.unansweredQuestions.length, 1);
  assert.equal(fs.existsSync(path.join(f.relay, "answered-calls.json")), false);
});

test("MCP discovers common tools and rejects invalid inputs without touching desktop", async (t) => {
  const f = fixture(t);
  const proc = f.child("mcp.mjs");
  let stdout = ""; proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_start", arguments: { prompt: 42 } } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const [code] = await once(proc, "exit"); assert.equal(code, 0);
  const responses = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.find((response) => response.id === 1).result.serverInfo.name, "codex-relay");
  const names = responses.find((response) => response.id === 2).result.tools.map((tool) => tool.name);
  for (const name of ["codex_reply", "codex_watch", "codex_events", "codex_watch_ack", "codex_supervise", "codex_preflight", "codex_host"]) assert.ok(names.includes(name));
  assert.equal(responses.find((response) => response.id === 3).result.isError, true);
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
    if (tool === "read_thread") return success({ thread: { id: args.threadId, cwd: f.dir, serviceTier: "default" }, turns: [] });
    if (tool === "create_thread") return success({ threadId: "execution-workflow" });
    if (tool === "wait_threads") return success({ polls: [{ thread: { id: "execution-workflow", status: { type: "active" } }, latestTurn: { id: "turn-1", status: "inProgress" } }] });
    throw new Error(`Unexpected workflow tool ${tool}`);
  });
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
  assert.match(created.args.prompt, /The regression check passes/);
  assert.equal(created.args.model, undefined);
  assert.equal(created.args.thinking, undefined);
  const again = await request("tools/call", { name: "codex_supervise", arguments: args });
  assert.equal(JSON.parse(again.content[0].text).replayed, true);
  assert.equal(calls.filter((call) => call.tool === "create_thread").length, 1);
  assert.equal(calls.filter((call) => call.tool === "send_message_to_thread").length, 0);
});

test("card-aware replies preserve agent provenance and deduplicate answers plus instructions", async (t) => {
  const f = fixture(t);
  f.env.CODEX_RELAY_IPC_PIPE = f.pipe("ipc");
  const messages = [], instructions = [];
  await mockDesktop(f, (request) => {
    const tool = request.params.tool;
    if (tool === "list_threads") return success({ threads: [] });
    if (tool === "read_thread") return success({ turns: [{ status: "inProgress", items: [{ type: "agentMessage", id: "call_routine", text: "Which implementation?" }] }] });
    if (tool === "send_message_to_thread") { instructions.push(request.params.arguments.prompt); return success({ sent: true }); }
    throw new Error(`Unexpected ${tool}`);
  });
  const ipc = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        if (request.type !== "request") continue;
        let result;
        if (request.method === "initialize") result = { resultType: "success", result: { clientId: "relay-client" } };
        else if (request.method === "thread-owner-discovery") result = { resultType: "success", handledByClientId: "window-1" };
        else if (request.method === "thread-follower-steer-turn") { messages.push(request.params); result = { resultType: "success", result: {} }; }
        else throw new Error(`Unexpected IPC ${request.method}`);
        const payload = Buffer.from(JSON.stringify({ type: "response", requestId: request.requestId, ...result }));
        const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
      }
    });
  });
  f.servers.push(ipc); ipc.listen(f.pipe("ipc")); await once(ipc, "listening");
  const file = path.join(f.dir, "reply.json");
  fs.writeFileSync(file, JSON.stringify({ requestId: "event-routine:reply", answerSource: "agent", answers: [{ callId: "call_routine", index: 0, text: "Use the existing adapter" }], message: "Continue within the agreed scope" }));
  const first = await f.cli("reply", "target-thread", "--input-file", file);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  assert.equal(first.value.answerSource, "agent");
  const second = await f.cli("reply", "target-thread", "--input-file", file);
  assert.equal(second.value.replayed, true);
  assert.equal(messages.length, 1); assert.equal(instructions.length, 1);
  assert.match(messages[0].input[0].text, /Delegated agent answer within the authorized task/);
  assert.match(messages[0].clientUserMessageId, /^[a-f0-9-]{36}$/);
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
  ].map(JSON.stringify).join("\n") + "\n");
  const [code] = await once(proc, "exit"); assert.equal(code, 0);
  const replies = stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(replies.find((r) => r.id === 1).result.tools.map((tool) => tool.name).sort(), ["codex_delivery", "codex_events", "codex_reply", "codex_status", "codex_watch_ack"]);
  assert.equal(replies.find((r) => r.id === 2).result.isError, true);
  assert.equal(replies.find((r) => r.id === 3).result.isError, true);
});

test("cancelling a long poll releases its socket so a background wait can finish promptly", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.relay, "token"), "test-token");
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(f.pipe("control")); await once(server, "listening");
  const code = `const {relay}=await import(${JSON.stringify(new URL("../transport.mjs", import.meta.url).href)});const c=new AbortController();setTimeout(()=>c.abort(),50);try{await relay('tools/call',{}, {signal:c.signal});process.exitCode=1}catch(e){console.log(JSON.stringify({error:e.message}))}`;
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
