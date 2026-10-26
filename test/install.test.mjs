import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, inspectInstallation } from "../scripts/install.mjs";

const installer = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
// Bun 1.2 on Windows reports a file blocking a recursive mkdir as ENOENT.
const directoryConflict = (error) => /ENOTDIR|EEXIST|not a directory/i.test(error.message) ||
  (Boolean(process.versions.bun) && error.code === "ENOENT" && error.syscall === "mkdir");

test("doctor distinguishes sandbox access denial from a missing caller or desktop reload", async (t) => {
  const f = fixture(t);
  write(path.join(f.source, "cli.mjs"), 'console.log(JSON.stringify({ok:false,error:"connect EPERM: local pipe access denied"}));process.exitCode=1;\n');
  await f.run("install", "--source", f.source);
  write(path.join(f.relay, "token"), "test-token");
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\codex-relay-doctor-${process.pid}` : path.join(f.dir, "doctor.sock");
  const server = net.createServer((socket) => socket.once("data", () => socket.end(JSON.stringify({ id: 1, result: { appPipe: true } }) + "\n")));
  const oldPipe = process.env.CODEX_RELAY_PIPE;
  try {
    server.listen(pipe); await once(server, "listening");
    process.env.CODEX_RELAY_PIPE = pipe;
    const result = await inspectInstallation({ home: f.home, platform: "win32" });
    assert.equal(result.configReady, true);
    assert.equal(result.status, "needsAccess");
    assert.equal(result.connected, true);
    assert.equal(result.callerReady, false);
    assert.match(result.next, /permission escalation/);
  } finally {
    if (oldPipe === undefined) delete process.env.CODEX_RELAY_PIPE; else process.env.CODEX_RELAY_PIPE = oldPipe;
    await new Promise((resolve) => server.close(resolve));
  }
});

// The default layout is Windows, the tested desktop platform; other layouts are selected explicitly.
function fixture(t, platform = "win32", prefix = "codex-relay-install-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const source = path.join(dir, "source");
  const home = path.join(dir, "home");
  const relay = path.join(home, ".codex-relay");
  for (const [name, contents] of Object.entries({
    "cli.mjs": "console.log('fixture');\n",
    "relay-server.mjs": "// fixture bridge\n",
    "mcp.mjs": "// fixture MCP\n",
    "daemon.mjs": 'console.log(JSON.stringify({ok:true,running:false}));\n',
    "service.mjs": "// fixture stable watcher launcher\n",
    "claude-mcp.mjs": "// fixture Claude MCP entry\n",
    "relay-cli.mjs": "// fixture bridge CLI entry\n",
    "codex-wait.mjs": "// fixture background wait entry\n",
    ...Object.fromEntries(["tools", "supervision", "event-context", "task-report", "task-target", "project-discovery", "model-policy", "outbox"].map((name) => [`src/tasks/${name}.mjs`, `// fixture ${name}\n`])),
    ...Object.fromEntries(["codex-client", "codex-ipc", "transport"].map((name) => [`src/desktop/${name}.mjs`, `// fixture ${name}\n`])),
    ...Object.fromEntries(["daemon-client", "watch-engine", "watch-store", "host-wake"].map((name) => [`src/watch/${name}.mjs`, `// fixture ${name}\n`])),
    "src/runtime/paths.mjs": "export const value = 42;\n",
    "src/runtime/sqlite.mjs": "// fixture SQLite runtime\n",
    "src/runtime/process-state.mjs": "// fixture process state\n",
    "README.md": "Fixture source\n",
    "skills/codex-relay/SKILL.md": "---\nname: codex-relay\ndescription: Fixture skill\n---\nUse {{RUNTIME}} {{CLI_PATH}}; manage {{INSTALL_PATH}}.\n",
    "skills/codex-relay/references/troubleshooting.md": "Read the diagnostics.\n",
    "scripts/install.mjs": fs.readFileSync(installer),
  })) write(path.join(source, name), contents);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => main([...args, "--home", home, "--platform", platform]);
  return { dir, source, home, relay, run, state: () => readJson(path.join(relay, "install.json")) };
}

test("incomplete source trees fail before changing installation integrations", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.source, "src", "desktop", "codex-ipc.mjs"));
  await assert.rejects(f.run("install", "--source", f.source), /Source is missing src\/desktop\/codex-ipc\.mjs/);
  assert.equal(fs.existsSync(path.join(f.home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(f.relay, "install.json")), false);
});

test("public CLI entries execute through a directory alias", (t) => {
  const f = fixture(t);
  const alias = path.join(f.dir, "source-alias");
  fs.symlinkSync(fileURLToPath(new URL("../", import.meta.url)), alias, process.platform === "win32" ? "junction" : "dir");
  const env = {
    ...process.env, CODEX_HOME: path.join(f.home, ".codex"), CODEX_RELAY_HOME: f.relay,
    CODEX_RELAY_DAEMON_PIPE: process.platform === "win32" ? `\\\\.\\pipe\\relay-entry-${path.basename(f.dir)}` : path.join(f.dir, "absent.sock"),
    CODEX_RELAY_STATE_DB: path.join(f.dir, "state.sqlite"),
  };
  for (const [entry, args, check] of [
    ["cli.mjs", ["help"], (value) => assert.equal(value.name, "codex-relay")],
    ["scripts/install.mjs", ["help"], (value) => assert.ok(value.commands.includes("doctor [--offline] [--json]"))],
    ["daemon.mjs", ["status"], (value) => assert.equal(value.running, false)],
  ]) {
    const result = spawnSync(process.execPath, [path.join(alias, entry), ...args], {
      cwd: f.dir, env, encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(result.stdout.trim(), `${entry} must execute its command through a directory alias`);
    check(JSON.parse(result.stdout));
  }
});

test("actual source snapshot runs root CLI, offline doctor, and MCP discovery from an isolated installation", async (t) => {
  const f = fixture(t);
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  const installed = await f.run("install", "--source", checkout, "--target", "both");
  assert.equal(installed.serviceStatus.skipped, true);
  const state = f.state();
  const env = {
    ...process.env, CODEX_HOME: path.join(f.home, ".codex"), CODEX_RELAY_HOME: f.relay,
    CODEX_RELAY_CHANNEL_SESSION_ID: "", CODEX_RELAY_WAKE_EVENT_ID: "",
    CODEX_APP_TOOLS_PIPE_PATH: "", CODEX_APP_TOOLS_CALLER_HOST_ID: "",
  };
  const runEntry = (entry, args = [], input) => {
    const result = spawnSync(state.runtime, [path.join(state.release, entry), ...args], {
      cwd: f.home, env, input, encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    return result.stdout.trim();
  };
  const help = JSON.parse(runEntry("cli.mjs", ["help"]));
  assert.equal(help.name, "codex-relay");
  assert.ok(help.commands.supervise);
  const doctor = JSON.parse(runEntry("cli.mjs", ["doctor", "--offline", "--home", f.home, "--platform", "win32"]));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.status, "configured");
  assert.equal(doctor.bridge.skipped, true);
  assert.equal(doctor.service.skipped, true);
  assert.equal(doctor.release, state.release);
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const responses = runEntry("mcp.mjs", [], requests.map(JSON.stringify).join("\n") + "\n")
    .split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.find((response) => response.id === 1).result.serverInfo.name, "codex-relay");
  const tools = responses.find((response) => response.id === 2).result.tools.map((tool) => tool.name);
  for (const name of ["codex_supervise", "codex_reply", "codex_event_context", "codex_watch_ack"]) assert.ok(tools.includes(name));
  assert.equal(fs.existsSync(path.join(state.release, "tools.mjs")), false);
  assert.equal(fs.existsSync(path.join(state.release, "src", "tasks", "tools.mjs")), true);
});

test("installs both skills and default MCP, preserves unrelated settings, and uninstalls cleanly", async (t) => {
  const f = fixture(t);
  const codex = path.join(f.home, ".codex", "config.toml");
  const claude = path.join(f.home, ".claude.json");
  const originalToml = 'model = "example"\n[mcp_servers.existing]\ncommand = "existing"';
  const originalClaude = { theme: "dark", mcpServers: { existing: { command: "existing" } } };
  write(codex, originalToml);
  write(claude, JSON.stringify(originalClaude));
  const result = await f.run("install", "--source", f.source, "--target", "both", "--mcp");
  assert.equal(result.status, "pendingReload");
  assert.deepEqual(result.targets, ["codex", "claude"]);
  assert.deepEqual(result.mcpTargets, ["codex", "claude"]);
  assert.equal(result.serviceStatus.skipped, true);
  const state = f.state();
  assert.equal(fs.readFileSync(path.join(state.release, "src", "runtime", "paths.mjs"), "utf8"), "export const value = 42;\n");
  for (const skill of state.skills) {
    const content = fs.readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
    assert.ok(content.includes(state.runtime));
    assert.ok(content.includes(path.join(state.release, "cli.mjs")));
    assert.ok(!content.includes("{{"));
  }
  const doctor = await inspectInstallation({ home: f.home, offline: true, platform: "win32" });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.configReady, true);
  assert.equal(doctor.status, "configured");
  assert.equal(readJson(claude).theme, "dark");
  const uninstalled = await f.run("uninstall");
  assert.equal(uninstalled.status, "uninstalled");
  assert.equal(fs.readFileSync(codex, "utf8"), originalToml);
  assert.deepEqual(readJson(claude), originalClaude);
  assert.equal(fs.existsSync(state.release), false);
  for (const skill of state.skills) assert.equal(fs.existsSync(skill.path), false);
  assert.equal((await f.run("uninstall")).status, "notInstalled");
});

test("repeat install is idempotent and targets can be added without duplicate tables", async (t) => {
  const f = fixture(t);
  await f.run("install", "--source", f.source, "--target", "codex");
  const initial = f.state();
  await f.run("install", "--source", f.source, "--target", "codex");
  assert.equal(f.state().release, initial.release);
  assert.equal(f.state().installId, initial.installId);
  await f.run("install", "--source", f.source, "--target", "claude");
  assert.deepEqual(f.state().targets, ["codex", "claude"]);
  const content = fs.readFileSync(path.join(f.home, ".codex", "config.toml"), "utf8");
  assert.equal(content.match(/\[mcp_servers.codex_relay_bridge\]/g).length, 1);
  // Without forwarding these by name, Codex starts the bridge without its private app-tools pipe.
  const bridge = content.slice(content.indexOf("[mcp_servers.codex_relay_bridge]"), content.indexOf("# END codex-relay:codex_relay_bridge"));
  assert.match(bridge, /^env_vars = \["CODEX_APP_TOOLS_PIPE_PATH","CODEX_APP_TOOLS_CALLER_HOST_ID"\]$/m);
  assert.deepEqual(f.state().mcpTargets, ["codex", "claude"]);
  assert.equal(fs.existsSync(path.join(f.home, ".claude.json")), true);
});

test("explicit CLI-only install adds no MCP targets and does not remove prior registrations", async (t) => {
  const f = fixture(t);
  await f.run("install", "--source", f.source, "--target", "codex", "--no-mcp");
  assert.deepEqual(f.state().mcpTargets, []);
  await f.run("install", "--source", f.source, "--target", "claude");
  assert.deepEqual(f.state().mcpTargets, ["claude"]);
  await f.run("install", "--source", f.source, "--target", "both", "--no-mcp");
  assert.deepEqual(f.state().mcpTargets, ["claude"]);
  await assert.rejects(f.run("install", "--source", f.source, "--mcp", "--no-mcp"), /cannot be combined/);
});

test("persistent watcher autostart is managed, follows updated source, and preserves durable watch data on uninstall", async (t) => {
  const f = fixture(t);
  await f.run("install", "--source", f.source);
  const before = f.state();
  assert.equal(before.service.autostart, true);
  assert.equal(before.managedFiles.length, 2);
  assert.equal(before.service.launcher, path.join(f.relay, "service.mjs"));
  const startup = fs.readFileSync(before.service.startupFile).toString("utf16le");
  assert.ok(startup.includes(before.runtime));
  assert.ok(startup.includes(before.service.launcher));
  assert.ok(startup.includes('supervise"", 0, False') || startup.includes('supervise", 0, False'));
  assert.ok(startup.includes("CODEX_RELAY_HOME"));
  assert.equal(fs.readFileSync(before.service.launcher, "utf8"), "// fixture stable watcher launcher\n");
  write(path.join(f.source, "service.mjs"), "// updated stable watcher launcher\n");
  await f.run("update", "--source", f.source);
  const after = f.state();
  assert.notEqual(after.release, before.release);
  assert.equal(fs.readFileSync(after.service.launcher, "utf8"), "// updated stable watcher launcher\n");
  assert.equal((await f.run("doctor", "--offline")).checks.find((item) => item.name === "watcherAutostart").ok, true);
  write(path.join(f.relay, "watches", "state.json"), '{"durable":true}');
  await f.run("uninstall");
  assert.equal(fs.existsSync(after.service.startupFile), false);
  assert.equal(fs.existsSync(after.service.launcher), false);
  assert.deepEqual(readJson(path.join(f.relay, "watches", "state.json")), { durable: true });
});

test("watcher startup conflicts and user edits are preserved", async (t) => {
  const f = fixture(t);
  const startup = path.join(f.home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Codex Relay.vbs");
  write(startup, "User startup script");
  await assert.rejects(f.run("install", "--source", f.source), /not managed/);
  assert.equal(fs.readFileSync(startup, "utf8"), "User startup script");
  assert.equal(fs.existsSync(path.join(f.relay, "install.json")), false);
  fs.unlinkSync(startup);
  await f.run("install", "--source", f.source);
  const state = f.state();
  write(state.service.launcher, "User launcher edit");
  await assert.rejects(f.run("update", "--source", f.source), /integration file was edited/);
  await assert.rejects(f.run("uninstall"), /integration file was edited/);
  assert.equal(fs.readFileSync(state.service.launcher, "utf8"), "User launcher edit");
  const doctor = await f.run("doctor", "--offline");
  assert.equal(doctor.status, "needsRepair");
  assert.equal(doctor.checks.find((item) => item.name === "watcherAutostart").ok, false);
});

test("existing server and skill conflicts do not change existing configuration", async (t) => {
  const f = fixture(t);
  const config = path.join(f.home, ".codex", "config.toml");
  const original = '[mcp_servers.codex_relay_bridge]\ncommand = "someone-else"\n';
  write(config, original);
  await assert.rejects(f.run("install", "--source", f.source), /already contains/);
  assert.equal(fs.readFileSync(config, "utf8"), original);
  assert.equal(fs.existsSync(path.join(f.relay, "install.json")), false);
  fs.unlinkSync(config);
  const skill = path.join(f.home, ".agents", "skills", "codex-relay", "SKILL.md");
  write(skill, "User-owned skill");
  await assert.rejects(f.run("install", "--source", f.source), /not managed/);
  assert.equal(fs.readFileSync(skill, "utf8"), "User-owned skill");
  assert.equal(fs.existsSync(config), false);
});

test("TOML inline, quoted, and dotted definitions cannot be silently duplicated", async (t) => {
  const f = fixture(t);
  const config = path.join(f.home, ".codex", "config.toml");
  for (const original of [
    '[ "mcp_servers" . "codex_relay_bridge" ]\ncommand = "owned"\n',
    "[ 'mcp_servers' . 'codex_relay_bridge' ]\ncommand = 'owned'\n",
    '[mcp_servers]\ncodex_relay_bridge = { command = "owned" }\n',
    "['mcp_servers']\n'codex_relay_bridge' = { command = 'owned' }\n",
    'mcp_servers.codex_relay_bridge.command = "owned"\n',
    "'mcp_servers' . 'codex_relay_bridge' . command = 'owned'\n",
    'mcp_servers = { existing = { command = "owned" } }\n',
  ]) {
    write(config, original);
    await assert.rejects(f.run("install", "--source", f.source), /already contains|inline mcp_servers/);
    assert.equal(fs.readFileSync(config, "utf8"), original);
  }
});

test("edited managed config is preserved on update and uninstall", async (t) => {
  const f = fixture(t);
  await f.run("install", "--source", f.source, "--mcp");
  const state = f.state();
  const config = path.join(f.home, ".codex", "config.toml");
  const edited = fs.readFileSync(config, "utf8").replace("startup_timeout_sec = 20", "startup_timeout_sec = 99");
  write(config, edited);
  await assert.rejects(f.run("update", "--source", f.source), /was edited/);
  await assert.rejects(f.run("uninstall"), /was edited/);
  assert.equal(fs.readFileSync(config, "utf8"), edited);
  assert.equal(fs.existsSync(state.release), true);
  assert.equal(fs.existsSync(path.join(f.relay, "install.json")), true);
  assert.equal((await inspectInstallation({ home: f.home, offline: true, platform: "win32" })).status, "needsRepair");
});

test("local source update switches all managed entries and retains previous source", async (t) => {
  const f = fixture(t);
  await f.run("install", "--source", f.source, "--target", "claude", "--mcp");
  const before = f.state();
  write(path.join(f.source, "cli.mjs"), "console.log('new fixture');\n");
  await f.run("update", "--source", f.source);
  const after = f.state();
  assert.notEqual(after.release, before.release);
  assert.equal(after.previousRelease, before.release);
  assert.equal(fs.existsSync(before.release), true);
  assert.deepEqual(after.targets, ["claude"]);
  assert.deepEqual(after.mcpTargets, ["claude"]);
  assert.equal(readJson(path.join(f.home, ".claude.json")).mcpServers.codex_relay.args[0], path.join(after.release, "mcp.mjs"));
  assert.equal((await inspectInstallation({ home: f.home, offline: true, platform: "win32" })).ok, true);
  await assert.rejects(f.run("update"), /no recorded Git origin/);
  await f.run("uninstall");
  assert.equal(fs.existsSync(before.release), false);
  assert.equal(fs.existsSync(after.release), false);
});

test("source integrity and edited skills are detected without overwriting edits", async (t) => {
  const f = fixture(t);
  await f.run("install", "--source", f.source, "--target", "claude");
  const state = f.state();
  write(path.join(state.release, "cli.mjs"), "// modified\n");
  const doctor = await inspectInstallation({ home: f.home, offline: true, platform: "win32" });
  assert.equal(doctor.ok, false);
  assert.equal(doctor.checks.find((check) => check.name === "sourceIntegrity").ok, false);
  const skill = path.join(state.skills[0].path, "SKILL.md");
  write(skill, "Custom user edit");
  await assert.rejects(f.run("install", "--source", f.source), /skill was edited/);
  await assert.rejects(f.run("uninstall"), /skill was edited/);
  assert.equal(fs.readFileSync(skill, "utf8"), "Custom user edit");
});

test("dry run leaves destination configuration and skill files absent", async (t) => {
  const f = fixture(t);
  const result = await f.run("install", "--source", f.source, "--dry-run");
  assert.equal(result.status, "planned");
  assert.equal(fs.existsSync(path.join(f.home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(f.relay, "install.json")), false);
  assert.equal(fs.existsSync(path.join(f.home, ".agents", "skills", "codex-relay")), false);
});

test("selected runtime works by PATH name and isolated home ignores real environment", async (t) => {
  const f = fixture(t);
  const runtimeName = process.versions.bun ? "bun" : "node";
  const result = await f.run("install", "--source", f.source, "--target", "claude", "--runtime", runtimeName);
  assert.ok(path.isAbsolute(result.runtime));
  assert.equal(f.state().codexConfig, path.join(f.home, ".codex", "config.toml"));
  assert.equal((await f.run("doctor", "--offline", "--json")).ok, true);
});

test("filesystem failure rolls back configuration, skill changes, and newly staged source", async (t) => {
  const f = fixture(t);
  const config = path.join(f.home, ".codex", "config.toml");
  const original = 'model = "preserve-me"\n';
  write(config, original);
  // The second skill cannot be written, after the first skill and config were updated.
  write(path.join(f.home, ".claude", "skills"), "A user file blocks this directory");
  await assert.rejects(f.run("install", "--source", f.source), directoryConflict);
  assert.equal(fs.readFileSync(config, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(f.home, ".claude", "skills"), "utf8"), "A user file blocks this directory");
  assert.equal(fs.existsSync(path.join(f.home, ".agents", "skills", "codex-relay")), false);
  assert.equal(fs.existsSync(path.join(f.relay, "install.json")), false);
  assert.deepEqual(fs.readdirSync(path.join(f.relay, "releases")), []);
});

test("a startup write failure restores config and removes the staged stable launcher", async (t) => {
  const f = fixture(t);
  const config = path.join(f.home, ".codex", "config.toml");
  const original = 'model = "preserve-before-startup"\n';
  write(config, original);
  write(path.join(f.home, "AppData"), "A user file blocks the startup directory");
  await assert.rejects(f.run("install", "--source", f.source), directoryConflict);
  assert.equal(fs.readFileSync(config, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(f.home, "AppData"), "utf8"), "A user file blocks the startup directory");
  assert.equal(fs.existsSync(path.join(f.relay, "service.mjs")), false);
  assert.equal(fs.existsSync(path.join(f.relay, "install.json")), false);
  assert.equal(fs.existsSync(path.join(f.home, ".agents", "skills", "codex-relay")), false);
  assert.equal(fs.existsSync(path.join(f.home, ".claude", "skills", "codex-relay")), false);
  assert.deepEqual(fs.readdirSync(path.join(f.relay, "releases")), []);
});

test("an installation lock rejects concurrent mutations without removing the existing lock", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.relay, "install.lock");
  write(lock, "Existing operation");
  await assert.rejects(f.run("install", "--source", f.source), /Another installation/);
  assert.equal(fs.readFileSync(lock, "utf8"), "Existing operation");
  assert.equal(fs.existsSync(path.join(f.home, ".codex", "config.toml")), false);
});

test("Git origin update fetches a fresh checkout without rewriting the user's source checkout", async (t) => {
  const f = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", f.source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Relay Test");
  git("add", ".");
  git("commit", "-m", "initial fixture");
  git("tag", "first-version");
  // A local Git remote gives a real clone/checkout test with no network side effects.
  git("remote", "add", "origin", f.source);
  await f.run("install", "--source", f.source);
  const before = f.state();
  write(path.join(f.source, "cli.mjs"), "console.log('remote update');\n");
  git("add", ".");
  git("commit", "-m", "updated fixture");
  const expected = git("rev-parse", "HEAD");
  await assert.rejects(f.run("update", "--source", f.source, "--ref", "first-version"), /HEAD does not match/);
  assert.equal(f.state().release, before.release);
  await f.run("update");
  assert.equal(f.state().source.commit, expected);
  assert.notEqual(f.state().release, before.release);
  assert.equal(git("rev-parse", "HEAD"), expected);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(fs.readdirSync(f.relay).some((name) => name.startsWith("update-")), false);
});

// Desktop Entry: undo the string-level escape and %% field-code escape, then split quoted arguments.
function desktopExec(text) {
  const line = text.split("\n").find((entry) => entry.startsWith("Exec="));
  const value = line.slice(5).replace(/\\(.)/g, (_, char) => char === "\\" ? "\\" : `\\${char}`).replaceAll("%%", "%");
  const args = [];
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) args.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
  return args;
}

test("macOS installs a managed LaunchAgent that starts the stable launcher and is removed on uninstall", async (t) => {
  const f = fixture(t, "darwin");
  await f.run("install", "--source", f.source);
  const state = f.state();
  assert.equal(state.service.startupFile, path.join(f.home, "Library", "LaunchAgents", "local.codex-relay.watcher.plist"));
  const plist = fs.readFileSync(state.service.startupFile, "utf8");
  assert.match(plist, /<key>Label<\/key><string>local\.codex-relay\.watcher<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  for (const value of [state.runtime, state.service.launcher, "supervise", f.relay, path.join(f.home, ".codex")]) assert.ok(strings.includes(value), value);
  assert.equal((await f.run("doctor", "--offline")).checks.find((item) => item.name === "watcherAutostart").ok, true);
  write(state.service.startupFile, "User LaunchAgent edit");
  await assert.rejects(f.run("uninstall"), /integration file was edited/);
  write(state.service.startupFile, plist);
  await f.run("uninstall");
  assert.equal(fs.existsSync(state.service.startupFile), false);
});

test("Linux installs an XDG autostart entry whose Exec line round-trips unusual paths", async (t) => {
  const f = fixture(t, "linux", "codex relay $HOME 100% `x` ");
  const existing = path.join(f.home, ".config", "autostart", "codex-relay.desktop");
  write(existing, "[Desktop Entry]\nName=User entry\n");
  await assert.rejects(f.run("install", "--source", f.source), /not managed/);
  fs.unlinkSync(existing);
  await f.run("install", "--source", f.source);
  const state = f.state();
  assert.equal(state.service.startupFile, existing);
  const entry = fs.readFileSync(existing, "utf8");
  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.match(entry, /\nNoDisplay=true\n/);
  assert.deepEqual(desktopExec(entry), ["env", `CODEX_RELAY_HOME=${f.relay}`, `CODEX_HOME=${path.join(f.home, ".codex")}`, state.runtime, state.service.launcher, "supervise"]);
  await f.run("uninstall");
  assert.equal(fs.existsSync(existing), false);
});

test("the platform layout option is only for isolated homes", async () => {
  await assert.rejects(main(["install", "--platform", "darwin"]), /isolated --home/);
  await assert.rejects(main(["install", "--home", path.resolve("isolated"), "--platform", "plan9"]), /must be win32, darwin, or linux/);
});
