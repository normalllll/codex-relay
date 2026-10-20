import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WatchStore } from "../watch-store.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(read, { timeoutMs = 10_000, label = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { const value = await read(); if (value) return value; }
    catch (error) { last = error; }
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-daemon-"));
  const nonce = crypto.randomUUID();
  const pipe = (name) => process.platform === "win32" ? `\\\\.\\pipe\\relay-daemon-test-${nonce}-${name}` : path.join(home, `${name}.sock`);
  const env = { ...process.env, CODEX_RELAY_HOME: home, CODEX_HOME: path.join(home, "codex"), CODEX_RELAY_DAEMON_PIPE: pipe("service"), CODEX_RELAY_PIPE: pipe("absent-desktop") };
  for (const name of ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_THREAD_ID", "CODEX_RELAY_STATE_DB", "CODEX_RELAY_WAKE_EVENT_ID", "CODEX_RELAY_WAKE_SUBSCRIPTION_ID", "CODEX_RELAY_WAKE_THREAD_ID"])
    delete env[name];
  fs.mkdirSync(env.CODEX_HOME);
  const children = new Set();
  const trackedPids = new Set();
  const recordLocks = () => {
    for (const name of ["watch-worker.lock", "watch-supervisor.lock"]) {
      try { const value = JSON.parse(fs.readFileSync(path.join(home, name), "utf8")); if (Number.isInteger(value.pid) && value.pid > 0) trackedPids.add(value.pid); } catch {}
    }
  };
  const run = (...args) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(root, "cli.mjs"), ...args], { env, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      children.delete(child);
      let value;
      try { value = JSON.parse(stdout.trim()); } catch { return reject(new Error(`Invalid CLI output: ${stdout}; ${stderr}; ${error?.message ?? ""}`)); }
      if (error) return reject(new Error(`CLI failed: ${JSON.stringify(value)}; ${stderr}`));
      recordLocks(); resolve(value);
    });
    children.add(child);
  });
  const request = (method, params = {}, token) => new Promise((resolve, reject) => {
    token ??= fs.readFileSync(path.join(home, "daemon-token"), "utf8").trim();
    const socket = net.createConnection(env.CODEX_RELAY_DAEMON_PIPE);
    socket.setEncoding("utf8");
    let buffer = "", settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Test daemon request timed out")), 3_000);
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(JSON.stringify({ id: 1, token, method, params }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try { finish(null, JSON.parse(buffer.split("\n")[0])); } catch (error) { finish(error); }
    });
  });
  t.after(async () => {
    for (const child of children) child.kill();
    recordLocks();
    try { await run("service", "stop"); } catch {
      for (const pid of trackedPids) { try { process.kill(pid); } catch {} }
    }
    const resolved = path.resolve(home);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("codex-relay-daemon-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { home, env, run, request, children, store: new WatchStore(home), recordLocks };
}

function channelClient(f, sessionId) {
  const child = spawn(process.execPath, [path.join(root, "mcp.mjs"), "--channel-session", sessionId], { env: f.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  f.children.add(child);
  const pending = new Map(), notifications = [];
  let buffer = "", stderr = "", id = 0;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message.result);
      } else notifications.push(message);
    }
  });
  child.once("exit", (code) => {
    f.children.delete(child);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`MCP exited ${code}: ${stderr}`)); }
    pending.clear();
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`MCP ${method} timed out: ${stderr}`)); }, 8_000);
    pending.set(current, { resolve, reject, timer }); send({ jsonrpc: "2.0", id: current, method, params });
  });
  const tool = async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    const value = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(JSON.stringify(value));
    return value;
  };
  return { child, notifications, rpc, tool, send, close: () => child.stdin.end() };
}

test("service lifecycle authenticates clients and restarts a crashed worker with subscriptions intact", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  assert.equal((await f.run("service", "status")).running, false);
  const started = await f.run("service", "start");
  assert.equal(started.running, true);
  assert.ok(Number.isInteger(started.pid));
  assert.equal((await f.run("service", "start")).pid, started.pid, "Starting an active service must be idempotent");
  const rejected = await f.request("list", {}, "invalid-token");
  assert.match(rejected.error.message, /Invalid watch service token/);
  const subscription = (await f.request("subscribe", { threadId: "fake-target", supervisor: { host: "claude", sessionId: "fake-session", mode: "channel" } })).result;
  const [event] = f.store.observe(subscription.id, { turnId: "turn-before-crash", turnStatus: "inProgress", questions: [{ callId: "question-before-crash", index: 0, question: "Choose a routine option" }] });
  assert.ok(event.id);
  f.recordLocks();
  // SIGTERM is a graceful zero-exit shutdown on Unix; SIGKILL exercises crash recovery everywhere.
  process.kill(started.pid, "SIGKILL");
  const restarted = await waitFor(async () => {
    const response = await f.request("status");
    return response.result?.running && response.result.pid !== started.pid ? response.result : null;
  }, { label: "worker restart" });
  assert.notEqual(restarted.pid, started.pid);
  f.recordLocks();
  assert.equal((await f.request("list")).result[0].id, subscription.id);
  assert.equal(f.store.events({ subscriptionId: subscription.id })[0].id, event.id);
  assert.equal((await f.run("service", "stop")).running, false);
  assert.equal((await f.run("service", "status")).running, false);
  const restartedAgain = await f.run("service", "start");
  assert.equal(restartedAgain.running, true);
  assert.equal((await f.request("list")).result[0].id, subscription.id);
});

test("MCP channel receives durable events, acknowledges rearm, and deduplicates across service restart", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const sessionId = "isolated-claude-session";
  const channel = channelClient(f, sessionId);
  const initialized = await channel.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "isolated-test", version: "1" } });
  assert.ok(initialized.capabilities.experimental["claude/channel"]);
  channel.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await waitFor(async () => (await f.request("status")).result?.channelSessions?.includes(sessionId), { label: "channel registration" });
  const subscription = await channel.tool("codex_watch", { threadId: "fake-task", supervisor: { host: "claude", sessionId, mode: "channel" } });
  const firstSnapshot = { turnId: "turn-1", turnStatus: "inProgress", questions: [{ callId: "question-1", index: 0, question: "Which authorized option?" }] };
  const [first] = f.store.observe(subscription.id, firstSnapshot);
  await waitFor(() => channel.notifications.find((message) => message.method === "notifications/claude/channel" && message.params.meta.event_id === first.id), { label: "first question notification" });
  const events = await channel.tool("codex_events", { subscriptionId: subscription.id });
  assert.equal(events[0].id, first.id);
  const handled = await channel.tool("codex_watch_ack", { eventId: first.id, action: "rearm" });
  assert.equal(handled.phase, "acknowledged");
  assert.deepEqual(f.store.observe(subscription.id, firstSnapshot), []);
  const secondSnapshot = { turnId: "turn-1", turnStatus: "inProgress", questions: [{ callId: "question-2", index: 0, question: "Which next authorized option?" }] };
  const [second] = f.store.observe(subscription.id, secondSnapshot);
  await waitFor(() => channel.notifications.find((message) => message.params?.meta?.event_id === second.id), { label: "rearmed question notification" });
  await channel.tool("codex_watch_ack", { eventId: second.id, action: "rearm" });
  await f.run("service", "stop");
  await f.run("service", "start");
  await waitFor(async () => (await f.request("status")).result?.channelSessions?.includes(sessionId), { label: "channel reconnect after service restart" });
  assert.deepEqual(f.store.observe(subscription.id, secondSnapshot), []);
  const [completed] = f.store.observe(subscription.id, { turnId: "turn-1", turnStatus: "completed", latestMessage: { text: "Finished" } });
  await waitFor(() => channel.notifications.find((message) => message.params?.meta?.event_id === completed.id), { label: "completion notification after restart" });
  assert.equal(channel.notifications.filter((message) => message.params?.meta?.event_id === first.id).length, 1);
  assert.equal(channel.notifications.filter((message) => message.params?.meta?.event_id === second.id).length, 1);
  const removed = await channel.tool("codex_unwatch", { subscriptionId: subscription.id });
  assert.equal(removed.removed, true);
  assert.deepEqual(await channel.tool("codex_watches", {}), []);
  assert.deepEqual(f.store.observe(subscription.id, { turnId: "turn-2", turnStatus: "completed", latestMessage: { text: "Another result" } }), []);
  channel.close();
  await once(channel.child, "exit");
});
