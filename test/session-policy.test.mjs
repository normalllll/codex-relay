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

async function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\relay-policy-${crypto.randomUUID()}` : path.join(home, "p.sock");
  const calls = [], sockets = new Set(), children = [];
  let confirmUnsubscribe;
  const unsubscribed = new Promise((resolve) => { confirmUnsubscribe = resolve; });
  const send = (socket, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const frame = Buffer.alloc(bytes.length + 4);
    frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); socket.write(frame);
  };
  const snapshot = (overrides = {}) => ({ type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "owner-1", version: 11,
    params: { hostId: "local", conversationId: "thread-1", change: { type: "snapshot", revision: 7,
      conversationState: { id: "thread-1", hostId: "local", resumeState: "resumed", latestThreadSettings: { serviceTier: "default" },
        turns: [{ text: "private-transcript" }], ...overrides } } } });
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4); calls.push(message);
        const respond = (result) => send(socket, { type: "response", requestId: message.requestId, ...result });
        if (message.method === "initialize") respond({ resultType: "success", result: { clientId: "reader-1" } });
        else if (message.method === "thread-owner-discovery") respond(options.noOwner ? { resultType: "error", error: "no-client-found" }
          : { resultType: "success", handledByClientId: "owner-1" });
        else if (message.method === "thread-follower-read-model-settings") respond({ resultType: "success", method: message.method,
          handledByClientId: options.changedOwner ? "owner-2" : "owner-1", result: { settings: { model: "example-model", resumeState: "resumed" } } });
        else if (message.method === "thread-stream-following-changed") {
          if (!message.params.following) { confirmUnsubscribe(); continue; }
          if (options.subscribe) options.subscribe(socket, send, snapshot);
          else send(socket, snapshot(options.state));
        } else assert.fail(`Unexpected IPC operation ${message.method}`);
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
  async function read(threadId = "thread-1") {
    const code = `import {readSessionPolicy} from ${JSON.stringify(adapter)};try{console.log(JSON.stringify({ok:true,value:await readSessionPolicy(${JSON.stringify(threadId)})}))}catch(error){console.log(JSON.stringify({ok:false,error:error.message}))}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_RELAY_HOME: home, CODEX_HOME: home, CODEX_RELAY_IPC_PIPE: pipe } });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [status] = await once(child, "close");
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout.trim());
  }
  return { calls, read, unsubscribed };
}

test("session policy reads the exact owner once, returns only tier evidence and unsubscribes", async (t) => {
  const f = await fixture(t);
  const result = await f.read(); await f.unsubscribed;
  assert.deepEqual(result, { ok: true, value: { threadId: "thread-1", available: true, serviceTier: "default", protocolVersion: 11, revision: 7 } });
  assert.doesNotMatch(JSON.stringify(result), /private-transcript|turns|model/);
  assert.deepEqual(f.calls.map((message) => message.method), ["initialize", "thread-owner-discovery", "thread-follower-read-model-settings", "thread-stream-following-changed", "thread-stream-following-changed"]);
  assert.deepEqual(f.calls.slice(3).map((message) => message.params.following), [true, false]);
  assert.equal(f.calls[1].params.hostId, "local");
  assert.equal(f.calls[1].params.conversationId, "thread-1");
  assert.equal(f.calls[1].version, 1);
  assert.equal(f.calls[2].targetClientId, "owner-1");
  for (const message of f.calls.slice(3)) { assert.deepEqual(message.targetClientIds, ["owner-1"]); assert.equal(message.version, 1); }
});

test("session settings preserve Fast and unknown values instead of inferring Standard", async (t) => {
  for (const tier of ["fast", "priority", "ultrafast", "future-tier", null, { nested: "private-value" }]) {
    const f = await fixture(t, { state: { latestThreadSettings: { serviceTier: tier } } });
    const result = await f.read(); await f.unsubscribed;
    assert.equal(result.ok, true);
    assert.equal(result.value.available, true);
    assert.equal(result.value.serviceTier, typeof tier === "string" ? tier : null);
    assert.doesNotMatch(JSON.stringify(result), /private-value/);
  }
});

test("missing or unsettled settings never establish a session tier", async (t) => {
  for (const state of [{ latestThreadSettings: {} }, { latestThreadSettings: null }, { resumeState: "resuming" }]) {
    const f = await fixture(t, { state });
    const result = await f.read(); await f.unsubscribed;
    assert.equal(result.ok, true);
    assert.equal(result.value.available, false);
    assert.equal(Object.hasOwn(result.value, "serviceTier"), false);
  }
});

test("owner changes and absent sessions do not subscribe or open another chat", async (t) => {
  for (const options of [{ noOwner: true }, { changedOwner: true }]) {
    const f = await fixture(t, options);
    const result = await f.read();
    assert.equal(options.noOwner ? result.value.available : result.ok, false);
    assert.equal(f.calls.some((message) => message.type === "broadcast"), false);
  }
});

test("other owners, hosts, threads and incremental patches cannot impersonate the snapshot", async (t) => {
  const f = await fixture(t, { subscribe(socket, send, snapshot) {
    const otherOwner = snapshot({ latestThreadSettings: { serviceTier: "default" } }); otherOwner.sourceClientId = "spoofed-owner"; send(socket, otherOwner);
    const otherThread = snapshot(); otherThread.params.conversationId = "other-thread"; send(socket, otherThread);
    const otherHost = snapshot(); otherHost.params.hostId = "remote"; send(socket, otherHost);
    const patch = snapshot(); patch.params.change.type = "patches"; send(socket, patch);
    send(socket, snapshot({ latestThreadSettings: { serviceTier: "fast" } }));
  } });
  const result = await f.read(); await f.unsubscribed;
  assert.equal(result.value.serviceTier, "fast");
});

test("incompatible protocols and mismatched snapshot identities fail closed and unsubscribe", async (t) => {
  for (const change of [message => { message.version = 12; }, message => { message.params.change.conversationState.id = "other-thread"; },
    message => { message.params.change.conversationState.hostId = "remote"; }, message => { message.params.change.revision = -1; }]) {
    const f = await fixture(t, { subscribe(socket, send, snapshot) { const message = snapshot(); change(message); send(socket, message); } });
    const result = await f.read(); await f.unsubscribed;
    assert.equal(result.ok, false);
    assert.match(result.error, /Unsupported or mismatched/);
  }
});

for (const [name, subscribe, error] of [
  ["an oversized response frame", socket => {
    const header = Buffer.alloc(4); header.writeUInt32LE(8 * 1024 * 1024 + 1); socket.write(header);
  }, /exceeds 8 MiB/],
  ["a null response frame", (socket, send) => send(socket, null), /Invalid codex-ipc response/],
  ["a malformed JSON response frame", socket => {
    const frame = Buffer.alloc(5); frame.writeUInt32LE(1); frame[4] = "{".charCodeAt(0); socket.write(frame);
  }, /Invalid codex-ipc response/],
  ["a disconnected snapshot", socket => socket.destroy(), /connection closed/],
]) test(`session policy rejects ${name} without retaining data`, async (t) => {
  const f = await fixture(t, { subscribe }); const result = await f.read();
  assert.equal(result.ok, false);
  assert.match(result.error, error);
  assert.doesNotMatch(JSON.stringify(result), /timed out|private-transcript/);
});

test("an unavailable snapshot times out once and releases the subscription", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { subscribe() {} });
  const result = await f.read(); await f.unsubscribed;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(f.calls.filter((message) => message.method === "thread-stream-following-changed" && message.params.following).length, 1);
});

test("invalid thread identifiers are rejected before any IPC operation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read("../invalid")).ok, false);
  assert.equal(f.calls.length, 0);
});
