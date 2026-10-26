import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";

const adapter = new URL("../src/desktop/codex-ipc.mjs", import.meta.url).href;
const text = "Fix the regression.\nRun the affected checks. $literal `content` 中文";
const messageId = "0b8b592f-c9bc-4897-b661-f9d2974955f4";

async function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-message-"));
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\relay-message-${crypto.randomUUID()}` : path.join(home, "ipc.sock");
  const calls = [], sockets = new Set(), children = [];
  const send = (socket, value) => {
    const bytes = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(bytes.length + 4);
    frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); socket.write(frame);
  };
  const snapshot = () => ({ type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "owner-1", version: 11,
    params: { hostId: "local", conversationId: "thread-1", change: { type: "snapshot", revision: 7,
      conversationState: { id: "thread-1", hostId: "local", resumeState: "resumed", threadRuntimeStatus: { type: "idle" },
        latestThreadSettings: { serviceTier: "default" }, turns: [{ id: "past-turn", status: "completed", text: "private-history" }],
        ...options.state } } } });
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4); calls.push(message);
        const respond = (result) => send(socket, { type: "response", requestId: message.requestId, ...result });
        if (message.method === "initialize") respond({ resultType: "success", result: { clientId: "relay-1" } });
        else if (message.method === "thread-owner-discovery") respond(options.noOwner
          ? { resultType: "error", error: "no-client-found" } : { resultType: "success", handledByClientId: "owner-1" });
        else if (message.method === "thread-follower-read-model-settings") respond({ resultType: "success", method: message.method,
          handledByClientId: "owner-1", result: { settings: { resumeState: "resumed" } } });
        else if (message.method === "thread-stream-following-changed") {
          if (!message.params.following) continue;
          if (options.snapshot) options.snapshot(socket, send, snapshot);
          else send(socket, snapshot());
        } else if (message.method === "thread-follower-start-turn" || message.method === "thread-follower-steer-turn") {
          if (options.disconnectAfterWrite) { socket.destroy(); continue; }
          const accepted = message.method === "thread-follower-start-turn"
            ? { turn: { id: "accepted-turn", status: "inProgress" } } : { turnId: "running-turn" };
          respond({ resultType: "success", method: message.method, handledByClientId: "owner-1", result: { result: accepted }, ...options.response });
        } else assert.fail(`Unexpected IPC method ${message.method}`);
      }
    });
  });
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exitCode === null ? once(child, "exit").catch(() => {}) : Promise.resolve()));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  server.listen(pipe); await once(server, "listening");
  async function invoke(overrides = {}, operation = "submitThread") {
    const args = { threadId: "thread-1", text, cwd: home, messageId, ...overrides };
    const code = `import {${operation}} from ${JSON.stringify(adapter)};const args=${JSON.stringify(args)};try{console.log(JSON.stringify({ok:true,value:await ${operation}(args.threadId,args.text,args.cwd,{messageId:args.messageId})}))}catch(error){console.log(JSON.stringify({ok:false,error:error.message,delivery:error.delivery}))}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_RELAY_HOME: home, CODEX_HOME: home, CODEX_RELAY_IPC_PIPE: pipe } });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [status] = await once(child, "close"); assert.equal(status, 0, stderr);
    return JSON.parse(stdout.trim());
  }
  return { calls, home, submit: (overrides) => invoke(overrides), steer: (overrides) => invoke(overrides, "steerThread") };
}

const writes = (f) => f.calls.filter((message) => ["thread-follower-start-turn", "thread-follower-steer-turn"].includes(message.method));

test("idle sessions start an ordinary turn containing only the work and inherited session settings", async (t) => {
  const f = await fixture(t);
  const result = await f.submit();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.method, "thread-follower-start-turn");
  assert.equal(writes(f).length, 1);
  const sent = writes(f)[0];
  assert.equal(sent.version, 2); assert.equal(sent.targetClientId, "owner-1");
  assert.deepEqual(sent.params, { conversationId: "thread-1", turnStart: {
    request: { threadId: "thread-1", input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: messageId },
    context: { inheritThreadSettings: true, restoreMessage: { id: messageId, text,
      context: { cwd: f.home, workspaceRoots: [f.home], collaborationMode: null, commentAttachments: [] } } },
  } });
  assert.doesNotMatch(JSON.stringify(result), /private-history|latestThreadSettings|serviceTier/);
  assert.equal(f.calls.some((call) => call.params?.following === false), true);
});

test("active sessions steer the existing turn with the same ordinary work input", async (t) => {
  const f = await fixture(t, { state: { threadRuntimeStatus: { type: "active" }, turns: [{ id: "running", status: "inProgress" }] } });
  const result = await f.submit();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(writes(f).length, 1);
  const sent = writes(f)[0];
  assert.equal(sent.method, "thread-follower-steer-turn"); assert.equal(sent.version, 1); assert.equal(sent.targetClientId, "owner-1");
  assert.equal(sent.params.clientUserMessageId, messageId);
  assert.deepEqual(sent.params.input, [{ type: "text", text, text_elements: [] }]);
  assert.deepEqual(sent.params.restoreMessage, { id: messageId, text,
    context: { cwd: f.home, workspaceRoots: [f.home], collaborationMode: null, commentAttachments: [] } });
  assert.deepEqual(sent.params.attachments, []);
  assert.equal(Object.hasOwn(sent.params, "sourceThreadId"), false);
});

test("resumed system errors start one ordinary turn after capacity failure while inheriting the existing model", async (t) => {
  const failure = { code: "model_capacity_exhausted", message: "The selected model is temporarily at capacity" };
  for (const history of [{ turns: [{ id: "failed-turn", status: "failed", error: failure }] },
    { turnHistory: { kind: "canonical" }, turns: [{ id: "stale-turn", status: "inProgress", error: failure }] }]) {
    const f = await fixture(t, { state: { resumeState: "resumed", threadRuntimeStatus: { type: "systemError" },
      latestThreadSettings: { model: "existing-model", serviceTier: "default" }, ...history } });
    const result = await f.submit();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(writes(f).map((message) => message.method), ["thread-follower-start-turn"]);
    const sent = writes(f)[0];
    assert.equal(sent.targetClientId, "owner-1"); assert.equal(sent.version, 2);
    assert.deepEqual(sent.params, { conversationId: "thread-1", turnStart: {
      request: { threadId: "thread-1", input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: messageId },
      context: { inheritThreadSettings: true, restoreMessage: { id: messageId, text,
        context: { cwd: f.home, workspaceRoots: [f.home], collaborationMode: null, commentAttachments: [] } } },
    } });
    assert.doesNotMatch(JSON.stringify(result), /model_capacity_exhausted|temporarily at capacity|existing-model/);
    assert.ok(f.calls.every((call) => ["initialize", "thread-owner-discovery", "thread-stream-following-changed", "thread-follower-start-turn"].includes(call.method)),
      "Recovery submits input without changing model settings or trying another transport");
  }
});

test("legacy snapshots select from the latest settled turn when runtime status is unavailable", async (t) => {
  for (const [turns, expected] of [[[], "thread-follower-start-turn"],
    [[{ status: "completed" }, { status: "inProgress" }], "thread-follower-steer-turn"],
    [[{ status: "inProgress" }, { status: "completed" }], "thread-follower-start-turn"],
    [[{ status: "failed" }], "thread-follower-start-turn"], [[{ status: "interrupted" }], "thread-follower-start-turn"]]) {
    const f = await fixture(t, { state: { threadRuntimeStatus: null, turns } });
    const result = await f.submit();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(writes(f).map((message) => message.method), [expected]);
  }
});

test("a missing desktop owner rejects without submitting or opening an application", async (t) => {
  const f = await fixture(t, { noOwner: true });
  const result = await f.submit();
  assert.equal(result.ok, false); assert.equal(result.delivery, "notSent");
  assert.equal(writes(f).length, 0);
  assert.deepEqual(f.calls.map((call) => call.method), ["initialize", "thread-owner-discovery"]);
});

test("unsettled, unknown and ambiguous snapshots cannot choose a delivery operation", async (t) => {
  for (const state of [{ resumeState: "resuming" }, { threadRuntimeStatus: { type: "unknown" } },
    { threadRuntimeStatus: { type: "notLoaded" } },
    { resumeState: "resuming", threadRuntimeStatus: { type: "systemError" } },
    { threadRuntimeStatus: { type: "systemError" }, unconfirmedTurnSubmissions: [{ id: "pending" }] },
    { threadRuntimeStatus: null, turns: null }, { unconfirmedTurnSubmissions: [{ id: "pending" }] },
    { threadRuntimeStatus: null, turns: [{ status: "futureStatus" }] },
    { threadRuntimeStatus: null, turnHistory: { kind: "canonical" }, turns: [{ status: "inProgress" }] }]) {
    const f = await fixture(t, { state });
    const result = await f.submit();
    assert.equal(result.ok, false, JSON.stringify({ state, result })); assert.equal(result.delivery, "notSent");
    assert.equal(writes(f).length, 0);
  }
});

test("snapshot protocol, identity and revision mismatches reject before submission", async (t) => {
  for (const mutate of [message => { message.version = 12; }, message => { message.params.change.conversationState.id = "other-thread"; },
    message => { message.params.change.conversationState.hostId = "remote"; }, message => { message.params.change.revision = -1; }]) {
    const f = await fixture(t, { snapshot(socket, send, snapshot) { const message = snapshot(); mutate(message); send(socket, message); } });
    const result = await f.submit();
    assert.equal(result.ok, false); assert.equal(result.delivery, "notSent"); assert.equal(writes(f).length, 0);
  }
});

test("malformed or disconnected snapshots fail before any work message is submitted", async (t) => {
  for (const snapshot of [(socket, send) => send(socket, null), socket => socket.destroy(), socket => {
    const header = Buffer.alloc(4); header.writeUInt32LE(8 * 1024 * 1024 + 1); socket.write(header);
  }]) {
    const f = await fixture(t, { snapshot }); const result = await f.submit();
    assert.equal(result.ok, false); assert.equal(result.delivery, "notSent"); assert.equal(writes(f).length, 0);
  }
});

test("unrelated owner, host and thread broadcasts do not override the exact owner's current state", async (t) => {
  const f = await fixture(t, { snapshot(socket, send, snapshot) {
    const otherOwner = snapshot(); otherOwner.sourceClientId = "other-owner"; send(socket, otherOwner);
    const otherThread = snapshot(); otherThread.params.conversationId = "other-thread"; send(socket, otherThread);
    const otherHost = snapshot(); otherHost.params.hostId = "remote"; send(socket, otherHost);
    const patch = snapshot(); patch.params.change.type = "patches"; send(socket, patch);
    const current = snapshot(); current.params.change.conversationState.threadRuntimeStatus = { type: "active" }; send(socket, current);
  } });
  assert.equal((await f.submit()).ok, true);
  assert.deepEqual(writes(f).map((message) => message.method), ["thread-follower-steer-turn"]);
});

test("a changed owner or mismatched submission acknowledgment has uncertain delivery and no alternate attempt", async (t) => {
  for (const response of [{ handledByClientId: "other-owner" }, { method: "wrong-method" }]) {
    const f = await fixture(t, { response }); const result = await f.submit();
    assert.equal(result.ok, false); assert.equal(result.delivery, "uncertain"); assert.equal(writes(f).length, 1);
  }
});

test("a success acknowledgment needs the host's nested start or steer acceptance before delivery is confirmed", async (t) => {
  for (const active of [false, true]) {
    const invalid = active
      ? [undefined, null, {}, { turnId: "flat-turn" }, { result: {} }, { result: { turnId: "" } }, { result: { turnId: null } }]
      : [undefined, null, {}, { turn: { id: "flat-turn" } }, { result: {} }, { result: { turn: {} } }, { result: { turn: { id: "" } } }];
    for (const result of invalid) {
      const f = await fixture(t, { state: { threadRuntimeStatus: { type: active ? "active" : "idle" } }, response: { result } });
      const delivered = await f.submit();
      assert.equal(delivered.ok, false, JSON.stringify({ active, result, delivered }));
      assert.equal(delivered.delivery, "uncertain");
      assert.deepEqual(writes(f).map((message) => message.method), [active ? "thread-follower-steer-turn" : "thread-follower-start-turn"]);
    }
  }
});

test("a disconnect after writing stays uncertain and does not fall back to delegated delivery", async (t) => {
  const f = await fixture(t, { disconnectAfterWrite: true }); const result = await f.submit();
  assert.equal(result.ok, false); assert.equal(result.delivery, "uncertain"); assert.equal(writes(f).length, 1);
});

test("explicit inactive-turn or handler rejection is not sent and does not start another turn", async (t) => {
  for (const error of ["no active turn to steer", "no-handler", "Cannot steer conversation thread-1 because its active turn already ended"]) {
    const f = await fixture(t, { state: { threadRuntimeStatus: { type: "active" } }, response: { resultType: "error", error } });
    const result = await f.submit();
    assert.equal(result.ok, false); assert.equal(result.delivery, "notSent");
    assert.deepEqual(writes(f).map((message) => message.method), ["thread-follower-steer-turn"]);
  }
});

test("invalid message inputs are rejected before opening a connection", async (t) => {
  const f = await fixture(t);
  for (const overrides of [{ threadId: "../invalid" }, { text: "" }, { text: null }]) {
    const result = await f.submit(overrides);
    assert.equal(result.ok, false, JSON.stringify({ overrides, result })); assert.equal(result.delivery, "notSent");
  }
  assert.equal(f.calls.length, 0);
});

test("structured answers steer exactly once with strict owner and operation acknowledgment", async (t) => {
  const answer = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "call-1", 0]), answer: "Keep the existing interface." }])}\n</send_user_message_question_reply>`;
  const f = await fixture(t);
  const result = await f.steer({ text: answer });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(writes(f).length, 1);
  assert.equal(writes(f)[0].params.input[0].text, answer);
  assert.equal(writes(f)[0].params.clientUserMessageId, messageId);
  assert.equal(writes(f)[0].targetClientId, "owner-1");
  assert.equal(f.calls.some((call) => call.method === "thread-stream-following-changed"), false);
});

test("structured answer acknowledgment mismatch or disconnected delivery remains uncertain", async (t) => {
  for (const options of [{ response: { handledByClientId: "other-owner" } }, { response: { method: "wrong-method" } },
    { response: { resultType: "error", error: "unexpected host exception" } }, { disconnectAfterWrite: true }]) {
    const f = await fixture(t, options); const result = await f.steer();
    assert.equal(result.ok, false); assert.equal(result.delivery, "uncertain");
    assert.deepEqual(writes(f).map((message) => message.method), ["thread-follower-steer-turn"]);
  }
});

test("structured answers require the nested nonempty accepted turn ID before confirming delivery", async (t) => {
  for (const result of [undefined, null, {}, { turnId: "flat-turn" }, { result: {} }, { result: { turnId: "" } }, { result: { turnId: null } }]) {
    const f = await fixture(t, { response: { result } }); const delivered = await f.steer();
    assert.equal(delivered.ok, false, JSON.stringify({ result, delivered }));
    assert.equal(delivered.delivery, "uncertain");
    assert.deepEqual(writes(f).map((message) => message.method), ["thread-follower-steer-turn"]);
  }
});

test("structured answer owner absence or explicit rejection does not fall back to an ordinary message", async (t) => {
  for (const options of [{ noOwner: true }, { response: { resultType: "error", error: "no active turn to steer" } },
    { response: { resultType: "error", error: "no-handler" } },
    { response: { resultType: "error", error: "Cannot steer conversation thread-1 because its active turn already ended" } }]) {
    const f = await fixture(t, options); const result = await f.steer();
    assert.equal(result.ok, false); assert.equal(result.delivery, "notSent");
    assert.deepEqual(writes(f).map((message) => message.method), options.noOwner ? [] : ["thread-follower-steer-turn"]);
  }
});
