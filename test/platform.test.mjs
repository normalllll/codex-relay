import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ipcPipe, controlPipeFor, unixSocket, clearStaleSocket, openUrlCommand } from "../paths.mjs";

test("desktop IPC follows the Codex app layout for each platform and honors an explicit override", () => {
  assert.equal(ipcPipe({ CODEX_RELAY_IPC_PIPE: "explicit" }, "linux"), "explicit");
  assert.equal(ipcPipe({}, "win32"), "\\\\.\\pipe\\codex-ipc");
  const codexHome = path.join(os.tmpdir(), `codex-relay-ipc-${process.pid}`);
  // Without a privately owned legacy socket, the current CODEX_HOME socket is used.
  assert.equal(ipcPipe({ CODEX_HOME: codexHome }, "darwin"), path.join(codexHome, "ipc", "ipc.sock"));
  assert.equal(ipcPipe({ CODEX_HOME: codexHome }, "linux"), path.join(codexHome, "ipc", "ipc.sock"));
});

test("relay sockets stay in the private relay home on Unix and reject paths over the platform limit", () => {
  assert.match(controlPipeFor("/home/user/.codex-relay", "win32"), /^\\\\\.\\pipe\\codex-relay-/);
  assert.equal(controlPipeFor(path.join(os.homedir(), ".codex-relay"), "linux"), path.join(os.homedir(), ".codex-relay", "relay.sock"));
  assert.throws(() => unixSocket(path.join(os.tmpdir(), "x".repeat(120)), "watch.sock"), /too long/);
});

test("desktop navigation uses the platform URL opener without a shell", () => {
  assert.deepEqual(openUrlCommand("codex://threads/a", "win32"), ["cmd.exe", ["/d", "/c", "start", "", "codex://threads/a"]]);
  assert.deepEqual(openUrlCommand("codex://threads/a", "darwin"), ["open", ["codex://threads/a"]]);
  assert.deepEqual(openUrlCommand("codex://threads/a", "linux"), ["xdg-open", ["codex://threads/a"]]);
});

test("a stale Unix socket is removed while a live listener is preserved", { skip: process.platform === "win32" && "Windows named pipes leave no file behind" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.sock");
  const live = net.createServer().listen(file);
  await once(live, "listening");
  assert.equal(await clearStaleSocket(file), false);
  assert.equal(fs.existsSync(file), true);
  await new Promise((resolve) => live.close(resolve));
  // A killed owner cannot unlink its socket file, and nothing accepts connections on it.
  const owner = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("ready"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await once(owner.stdout, "data");
  owner.kill("SIGKILL"); await once(owner, "exit");
  assert.equal(fs.existsSync(file), true);
  assert.equal(await clearStaleSocket(file), true);
  assert.equal(fs.existsSync(file), false);
});
