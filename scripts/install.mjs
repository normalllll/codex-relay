// Source-only installation. Compatible with Node and Bun; no package manager or build step.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { controlPipeFor } from "../paths.mjs";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = ".codex-relay-managed.json";
const LAUNCH_AGENT = "local.codex-relay.watcher";
const REQUIRED = ["cli.mjs", "mcp.mjs", "relay-server.mjs", "daemon.mjs", "service.mjs", "supervision.mjs", "model-policy.mjs", "event-context.mjs", "task-report.mjs", "paths.mjs", "skills/codex-relay/SKILL.md", "scripts/install.mjs"];
const roots = new Set(["src", "lib", "scripts", "skills", "assets", "docs"]);
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file) : null;
const json = (file) => { const data = read(file); return data ? JSON.parse(data) : null; };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw new Error(`Refusing operation outside managed directory: ${target}`);
  // Reparse points / symlinks can redirect an otherwise-contained lexical path.
  let cursor = path.resolve(root);
  if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Managed root is a symlink: ${cursor}`);
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Managed path is a symlink: ${cursor}`);
  }
  return path.resolve(target);
}

function remove(root, target) {
  inside(root, target);
  fs.rmSync(target, { recursive: true, force: true });
}

function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, data); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function parse(argv) {
  const options = { command: argv[0] ?? "help" };
  const flags = new Set(["mcp", "no-mcp", "json", "offline", "dry-run"]);
  const values = new Set(["target", "runtime", "home", "source", "ref", "platform"]);
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || (!flags.has(key) && !values.has(key))) throw new Error(`Unknown option ${argv[i]}`);
    if (flags.has(key)) options[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for --${key}`);
      options[key] = argv[++i];
    }
  }
  if (options.target && !["codex", "claude", "both"].includes(options.target)) throw new Error("--target must be codex, claude, or both");
  if (options.mcp && options["no-mcp"]) throw new Error("--mcp and --no-mcp cannot be combined");
  if (options.ref?.startsWith("-")) throw new Error("--ref must be a Git ref, not an option");
  if (options.platform && !["win32", "darwin", "linux"].includes(options.platform)) throw new Error("--platform must be win32, darwin, or linux");
  if (options.platform && !options.home) throw new Error("--platform only selects the layout of an isolated --home");
  return options;
}

function locations(options) {
  if (options.home && !path.isAbsolute(options.home)) throw new Error("--home must be an absolute path");
  const home = options.home ? path.resolve(options.home) : os.homedir();
  const relay = path.resolve(options.home ? path.join(home, ".codex-relay") : process.env.CODEX_RELAY_HOME || path.join(home, ".codex-relay"));
  const codex = path.resolve(options.home ? path.join(home, ".codex") : process.env.CODEX_HOME || path.join(home, ".codex"));
  // Login autostart: the Startup folder on Windows, a LaunchAgent on macOS, XDG autostart elsewhere.
  const platform = options.platform ?? process.platform;
  const startup = platform === "win32" ? path.join(options.home ? path.join(home, "AppData", "Roaming") : process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    : platform === "darwin" ? path.join(home, "Library", "LaunchAgents")
    : path.join(options.home ? path.join(home, ".config") : process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart");
  const startupName = platform === "win32" ? "Codex Relay.vbs" : platform === "darwin" ? `${LAUNCH_AGENT}.plist` : "codex-relay.desktop";
  return {
    home, relay, codex, platform, state: path.join(relay, "install.json"),
    releases: path.join(relay, "releases"),
    codexConfig: path.join(codex, "config.toml"),
    claudeConfig: path.join(home, ".claude.json"),
    codexSkill: path.join(home, ".agents", "skills", "codex-relay"),
    claudeSkill: path.join(home, ".claude", "skills", "codex-relay"),
    startup, startupFile: path.join(startup, startupName), launcher: path.join(relay, "service.mjs"),
  };
}

function managedFile(loc, file) {
  if (file === loc.launcher) return inside(loc.relay, file);
  if (file === loc.startupFile) return inside(loc.startup, file);
  throw new Error(`Unknown managed integration file: ${file}`);
}

function assertManagedFiles(loc, state, proposed) {
  for (const file of proposed) {
    managedFile(loc, file);
    const current = read(file);
    if (current === null) continue;
    const owned = state?.managedFiles?.find((entry) => entry.path === file);
    if (!owned) throw new Error(`Integration file already exists and is not managed by this installation: ${file}`);
    if (digest(current) !== owned.hash) throw new Error(`Managed integration file was edited: ${file}; preserve or move it before retrying`);
  }
}

function startupScript(runtime, loc) {
  const args = [runtime, loc.launcher, "supervise"];
  const env = { CODEX_RELAY_HOME: loc.relay, CODEX_HOME: loc.codex };
  if (loc.platform !== "win32" && [...args, ...Object.values(env)].some((value) => /[\0\r\n]/.test(value)))
    throw new Error("Runtime and installation paths must not contain line breaks");
  if (loc.platform === "darwin") {
    const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return Buffer.from([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      "<!-- Managed by Codex Relay. Starts the background watcher at login; no desktop app is opened. -->",
      '<plist version="1.0">', "<dict>",
      `  <key>Label</key><string>${LAUNCH_AGENT}</string>`,
      "  <key>ProgramArguments</key>", "  <array>", ...args.map((value) => `    <string>${xml(value)}</string>`), "  </array>",
      "  <key>EnvironmentVariables</key>", "  <dict>", ...Object.entries(env).map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`), "  </dict>",
      "  <key>RunAtLoad</key><true/>",
      "  <key>ProcessType</key><string>Background</string>",
      "</dict>", "</plist>", "",
    ].join("\n"));
  }
  if (loc.platform !== "win32") {
    // Desktop Entry Exec quoting, then the string-level escape that doubles backslashes; % starts a field code.
    const quote = (value) => `"${String(value).replace(/[\\"`$]/g, "\\$&")}"`;
    const exec = ["env", ...Object.entries(env).map(([key, value]) => quote(`${key}=${value}`)), ...args.map(quote)].join(" ")
      .replaceAll("\\", "\\\\").replaceAll("%", "%%");
    return Buffer.from([
      "[Desktop Entry]",
      "# Managed by Codex Relay. Starts the background watcher at login; no desktop app is opened.",
      "Type=Application", "Name=Codex Relay watcher", `Exec=${exec}`,
      "NoDisplay=true", "Terminal=false", "X-GNOME-Autostart-enabled=true", "",
    ].join("\n"));
  }
  const literal = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const text = [
    "' Managed by Codex Relay. The window is hidden; no desktop app is opened.",
    'Set shell = CreateObject("WScript.Shell")',
    'Set environment = shell.Environment("PROCESS")',
    `environment("CODEX_RELAY_HOME") = ${literal(loc.relay)}`,
    `environment("CODEX_HOME") = ${literal(loc.codex)}`,
    `shell.Run ${literal(`"${runtime}" "${loc.launcher}" supervise`)}, 0, False`,
    "",
  ].join("\r\n");
  return Buffer.from(`\uFEFF${text}`, "utf16le");
}

function serviceCommand(loc, state, command) {
  const probe = spawnSync(state.runtime, [path.join(state.release, "daemon.mjs"), command], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, CODEX_RELAY_HOME: loc.relay, CODEX_HOME: loc.codex },
  });
  let result;
  try { result = JSON.parse(probe.stdout?.trim()); } catch {}
  if (probe.error || probe.status !== 0 || result?.ok === false || !result)
    throw new Error(`Watcher service ${command} failed: ${probe.error?.message || result?.error || probe.stderr?.trim() || "invalid response"}`);
  return result;
}

function runtimeInfo(runtime) {
  const probe = spawnSync(runtime, ["-e", "const sqlite=require(process.versions.bun?'bun:sqlite':'node:sqlite');const DB=sqlite.DatabaseSync??sqlite.Database;const db=new DB(':memory:');db.close();console.log(JSON.stringify({path:process.execPath,node:process.versions.node,bun:process.versions.bun??null}))"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (probe.error || probe.status !== 0) throw new Error(`Cannot execute runtime ${runtime}: ${probe.error?.message || probe.stderr}`);
  let info;
  try { info = JSON.parse(probe.stdout.trim()); } catch { throw new Error(`Runtime returned invalid diagnostics: ${runtime}`); }
  const [major, minor] = String(info.bun ?? info.node).split(".").map(Number);
  if (info.bun ? major < 1 || (major === 1 && minor < 2) : major < 22 || (major === 22 && minor < 16))
    throw new Error("Node.js >=22.16 or Bun >=1.2 with built-in SQLite is required");
  return info;
}

function sourceFiles(source) {
  const result = {};
  function walk(dir, relative = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${name}`);
      if (!relative && !(entry.isDirectory() ? roots.has(entry.name) : /\.(mjs|md)$/i.test(entry.name) || entry.name === "package.json")) continue;
      if (["node_modules", ".git", ".DS_Store"].includes(entry.name)) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), name);
      else if (entry.isFile()) result[name] = fs.readFileSync(path.join(dir, entry.name));
    }
  }
  walk(source);
  for (const name of REQUIRED) if (!result[name]) throw new Error(`Source is missing ${name}`);
  return result;
}

function git(source, args, allowFailure = false) {
  const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args[0]} failed: ${result.error?.message || result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function sourceInfo(source, options) {
  return { path: source, url: git(source, ["remote", "get-url", "origin"], true), commit: git(source, ["rev-parse", "HEAD"], true), ref: options.ref ?? git(source, ["symbolic-ref", "--short", "HEAD"], true) ?? "main" };
}

// Codex passes its private app-tools pipe only to servers that forward it by name in env_vars.
const BRIDGE_ENV_VARS = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_APP_TOOLS_CALLER_HOST_ID"];

function block(name, entry) {
  const q = JSON.stringify;
  return `# BEGIN codex-relay:${name}\n[mcp_servers.${name}]\ncommand = ${q(entry.command)}\nargs = ${q(entry.args)}\nstartup_timeout_sec = 20\nenv = { ${Object.entries(entry.env).map(([key, value]) => `${key} = ${q(value)}`).join(", ")} }\n${entry.envVars ? `env_vars = ${q(entry.envVars)}\n` : ""}# END codex-relay:${name}\n`;
}

function findBlock(text, name) {
  const starts = [...text.matchAll(new RegExp(`^# BEGIN codex-relay:${name}\\r?$`, "gm"))];
  if (starts.length > 1) throw new Error(`Duplicate managed config blocks for ${name}`);
  const start = starts[0];
  if (!start) return null;
  const begin = start.index;
  const tail = text.slice(begin + start[0].length);
  const end = new RegExp(`^# END codex-relay:${name}\\r?$`, "m").exec(tail);
  if (!end) throw new Error(`Incomplete managed config block ${name}`);
  let last = begin + start[0].length + end.index + end[0].length;
  if (text[last] === "\r") last++;
  if (text[last] === "\n") last++;
  return text.slice(begin, last);
}

function setBlock(text, name, content, previous) {
  const existing = findBlock(text, name);
  if (previous) {
    if (existing !== previous) throw new Error(`Codex config ${name} was edited since installation; preserve the edit and resolve it before retrying`);
    return text.replace(existing, content);
  }
  const namespace = `(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
  const key = `(?:${name}|"${name}"|'${name}')`;
  const table = new RegExp(`^\\s*\\[\\s*${namespace}\\s*\\.\\s*${key}\\s*(?:\\.[^\\]]+)?\\]`, "m");
  const dotted = new RegExp(`^\\s*${namespace}\\s*\\.\\s*${key}\\s*(?:\\.|=)`, "m");
  let section = "";
  let direct = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+)\s*\]/.exec(line);
    if (header) section = header[1].trim().replace(/["']/g, "");
    else if (section === "mcp_servers" && new RegExp(`^\\s*${key}\\s*=`).test(line)) direct = true;
  }
  if (existing || table.test(text) || dotted.test(text) || direct) throw new Error(`Codex config already contains ${name}; refusing to overwrite an existing server`);
  if (new RegExp(`^\\s*${namespace}\\s*=\\s*\\{`, "m").test(text)) throw new Error("Codex uses an inline mcp_servers table; convert it to named tables before installing");
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${content}`;
}

function skillFiles(files, runtime, release, id) {
  const result = {};
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith("skills/codex-relay/")) continue;
    const relative = name.slice("skills/codex-relay/".length);
    result[relative] = name.endsWith(".md") ? Buffer.from(data.toString("utf8")
      .replaceAll("{{RUNTIME}}", runtime)
      .replaceAll("{{CLI_PATH}}", path.join(release, "cli.mjs"))
      .replaceAll("{{INSTALL_PATH}}", path.join(release, "scripts", "install.mjs"))) : data;
  }
  result[MARKER] = Buffer.from(JSON.stringify({ owner: "codex-relay", installId: id }));
  return result;
}

function treeFiles(dir) {
  const files = {};
  if (!fs.existsSync(dir)) return files;
  function walk(root, relative = "") {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Managed directory contains a symlink: ${path.join(root, entry.name)}`);
      if (entry.isDirectory()) walk(path.join(root, entry.name), name);
      else if (entry.isFile()) files[name] = fs.readFileSync(path.join(root, entry.name));
    }
  }
  walk(dir);
  return files;
}

const hashes = (files) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => [name, digest(data)]));

function assertSkill(dir, state) {
  if (!fs.existsSync(dir)) return;
  const marker = json(path.join(dir, MARKER));
  if (!state || marker?.installId !== state.installId) throw new Error(`Skill directory already exists and is not managed by this installation: ${dir}`);
  const expected = state.skills.find((skill) => skill.path === dir);
  if (!expected || !equal(hashes(treeFiles(dir)), expected.hashes)) throw new Error(`Installed skill was edited: ${dir}; preserve or move it before retrying`);
}

function writeTree(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const destination = inside(dir, path.join(dir, name));
    atomic(destination, data);
  }
}

function withLock(loc, action) {
  fs.mkdirSync(loc.relay, { recursive: true });
  const lock = path.join(loc.relay, "install.lock");
  let fd;
  try { fd = fs.openSync(lock, "wx"); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Another installation may be running. Check ${lock} before removing a stale lock.`); throw error; }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try { return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function installSource(options, loc, source, previous) {
  source = path.resolve(source);
  if (previous && (previous.codexConfig !== loc.codexConfig || previous.claudeConfig !== loc.claudeConfig))
    throw new Error("Installation profile changed; use the same --home / CODEX_HOME as the original installation");
  if (previous?.service && (previous.service.launcher !== loc.launcher || previous.service.startupFile !== loc.startupFile))
    throw new Error("Watcher startup profile changed; use the original user profile and CODEX_RELAY_HOME");
  if (options.ref) {
    const requested = git(source, ["rev-parse", "--verify", `${options.ref}^{commit}`]);
    const actual = git(source, ["rev-parse", "HEAD"]);
    if (actual !== requested) throw new Error(`Local checkout HEAD does not match --ref ${options.ref}; check out the requested ref first. No source checkout was changed.`);
  }
  const files = sourceFiles(source);
  const sourceHashes = hashes(files);
  const version = digest(JSON.stringify(sourceHashes)).slice(0, 20);
  const release = inside(loc.relay, path.join(loc.releases, version));
  const runtime = runtimeInfo(options.runtime ?? previous?.runtime ?? process.execPath).path;
  const target = options.target ?? (previous ? (previous.targets.length === 2 ? "both" : previous.targets[0]) : "both");
  const targets = [...new Set([...(previous?.targets ?? []), ...(target === "both" ? ["codex", "claude"] : [target])])];
  const mcpTargets = [...new Set([...(previous?.mcpTargets ?? []), ...(!options["no-mcp"] ? (target === "both" ? ["codex", "claude"] : [target]) : [])])];
  const id = previous?.installId ?? crypto.randomUUID();
  const integrationFiles = { [loc.launcher]: files["service.mjs"], [loc.startupFile]: startupScript(runtime, loc) };
  assertManagedFiles(loc, previous, Object.keys(integrationFiles));
  const skill = skillFiles(files, runtime, release, id);
  const skillDirs = targets.map((name) => loc[`${name}Skill`]);
  for (const dir of skillDirs) { inside(loc.home, dir); assertSkill(dir, previous); }
  const env = { CODEX_RELAY_HOME: loc.relay, CODEX_HOME: loc.codex };
  const bridge = { command: runtime, args: [path.join(release, "relay-server.mjs")], env, envVars: BRIDGE_ENV_VARS };
  const client = { command: runtime, args: [path.join(release, "mcp.mjs")], env };
  if (mcpTargets.length && !files["mcp.mjs"]) throw new Error("Source is missing optional MCP entry mcp.mjs");
  const oldToml = read(loc.codexConfig);
  let toml = oldToml?.toString("utf8") ?? "";
  const configBlocks = { codex_relay_bridge: block("codex_relay_bridge", bridge) };
  if (mcpTargets.includes("codex")) configBlocks.codex_relay = block("codex_relay", client);
  for (const [name, content] of Object.entries(configBlocks)) toml = setBlock(toml, name, content, previous?.configBlocks?.[name]);
  const oldClaude = read(loc.claudeConfig);
  let claude;
  if (mcpTargets.includes("claude")) {
    claude = oldClaude ? JSON.parse(oldClaude.toString("utf8")) : {};
    if (!claude || typeof claude !== "object" || Array.isArray(claude)) throw new Error("Claude configuration must be a JSON object");
    claude.mcpServers ??= {};
    if (!claude.mcpServers || typeof claude.mcpServers !== "object" || Array.isArray(claude.mcpServers)) throw new Error("Claude mcpServers must be an object");
    const existing = claude.mcpServers.codex_relay;
    if (previous?.claudeEntry ? !equal(existing, previous.claudeEntry) : existing !== undefined) throw new Error("Claude codex_relay MCP entry already exists or was edited; refusing to overwrite it");
    claude.mcpServers.codex_relay = { type: "stdio", ...client };
  }
  const state = {
    schemaVersion: 2, installId: id, installedAt: previous?.installedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
    runtime, targets, mcpTargets, source: previous?.release === source ? previous.source : sourceInfo(source, options), release, sourceHashes,
    previousRelease: previous?.release !== release ? previous?.release ?? null : previous?.previousRelease ?? null,
    managedReleases: [...new Set([...(previous?.managedReleases ?? []), previous?.release, release].filter(Boolean))],
    configBlocks, claudeEntry: claude?.mcpServers.codex_relay ?? previous?.claudeEntry ?? null,
    codexInsertedNewline: previous?.codexInsertedNewline ?? (Boolean(oldToml?.length) && !oldToml.toString("utf8").endsWith("\n")),
    codexConfig: loc.codexConfig, claudeConfig: loc.claudeConfig,
    codexConfigExisted: previous?.codexConfigExisted ?? oldToml !== null,
    claudeConfigExisted: previous?.claudeConfigExisted ?? oldClaude !== null,
    skills: skillDirs.map((dir) => ({ path: dir, hashes: hashes(skill) })),
    service: { launcher: loc.launcher, startupFile: loc.startupFile, autostart: true },
    managedFiles: Object.entries(integrationFiles).map(([file, data]) => ({ path: file, hash: digest(data) })),
  };
  const result = { ok: true, status: "pendingReload", targets, mcpTargets, runtime, release, stateFile: loc.state, service: state.service, next: "Run doctor after the Codex desktop app has reloaded its MCP configuration. No desktop app has been restarted." };
  if (options["dry-run"]) return { ...result, status: "planned", dryRun: true };
  const existed = fs.existsSync(release);
  if (existed && !equal(hashes(treeFiles(release)), sourceHashes)) throw new Error(`Installed release was modified: ${release}`);
  const backupSkills = skillDirs.map((dir) => ({ dir, existed: fs.existsSync(dir), files: treeFiles(dir) }));
  const backupIntegration = Object.keys(integrationFiles).map((file) => ({ file, data: read(file) }));
  const oldState = read(loc.state);
  const restartService = !options.home;
  if (restartService && previous?.service) serviceCommand(loc, previous, "stop");
  try {
    if (!existed) writeTree(release, files);
    atomic(loc.codexConfig, toml);
    if (claude) atomic(loc.claudeConfig, `${JSON.stringify(claude, null, 2)}\n`);
    for (const dir of skillDirs) {
      if (fs.existsSync(dir)) remove(loc.home, dir);
      writeTree(dir, skill);
    }
    for (const [file, data] of Object.entries(integrationFiles)) atomic(file, data);
    atomic(loc.state, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    for (const [file, contents] of [[loc.codexConfig, oldToml], [loc.claudeConfig, oldClaude], [loc.state, oldState]]) {
      if (contents === null) { if (fs.existsSync(file)) fs.unlinkSync(file); } else atomic(file, contents);
    }
    for (const backup of backupSkills) {
      if (fs.existsSync(backup.dir)) remove(loc.home, backup.dir);
      if (backup.existed) writeTree(backup.dir, backup.files);
    }
    for (const { file, data } of backupIntegration) {
      if (data === null) { if (fs.existsSync(file)) fs.unlinkSync(file); } else atomic(file, data);
    }
    if (!existed && fs.existsSync(release)) remove(loc.relay, release);
    if (restartService && previous?.service) {
      try { serviceCommand(loc, previous, "start"); } catch (restartError) { error.message += `; previous service restart failed: ${restartError.message}`; }
    }
    throw error;
  }
  if (restartService) {
    try { result.serviceStatus = serviceCommand(loc, state, "start"); }
    catch (error) { return { ...result, ok: false, status: "needsService", error: error.message, next: `Installation was preserved. Run ${runtime} ${path.join(release, "daemon.mjs")} start, then doctor.` }; }
  } else result.serviceStatus = { running: null, skipped: true, reason: "isolatedHome" };
  return result;
}

function uninstall(options, loc, state) {
  if (!state) return { ok: true, status: "notInstalled" };
  if (state.codexConfig !== loc.codexConfig || state.claudeConfig !== loc.claudeConfig)
    throw new Error("Installation profile changed; use the same --home / CODEX_HOME as the original installation");
  const integration = state.managedFiles ?? [];
  assertManagedFiles(loc, state, integration.map((entry) => entry.path));
  let toml = read(loc.codexConfig)?.toString("utf8") ?? "";
  for (const [name, content] of Object.entries(state.configBlocks).reverse()) {
    const existing = findBlock(toml, name);
    if (existing && existing !== content) throw new Error(`Codex config ${name} was edited; uninstall left the installation unchanged`);
    if (existing) {
      const index = toml.indexOf(existing);
      if (name === "codex_relay_bridge" && state.codexInsertedNewline && index > 0 && toml[index - 1] === "\n")
        toml = `${toml.slice(0, index - 1)}${toml.slice(index + existing.length)}`;
      else toml = toml.replace(existing, "");
    }
  }
  let claude = json(loc.claudeConfig);
  if (state.claudeEntry && claude?.mcpServers?.codex_relay !== undefined) {
    if (!equal(claude.mcpServers.codex_relay, state.claudeEntry)) throw new Error("Claude MCP entry was edited; uninstall left the installation unchanged");
    delete claude.mcpServers.codex_relay;
    if (!Object.keys(claude.mcpServers).length) delete claude.mcpServers;
  }
  for (const skill of state.skills) { inside(loc.home, skill.path); assertSkill(skill.path, state); }
  const releases = [...new Set(state.managedReleases ?? [state.release, state.previousRelease].filter(Boolean))];
  for (const release of releases) inside(loc.releases, release);
  if (options["dry-run"]) return { ok: true, status: "planned", dryRun: true, action: "uninstall" };
  const backupFiles = [loc.codexConfig, loc.claudeConfig, loc.state, ...integration.map((entry) => entry.path)].map((file) => ({ file, data: read(file) }));
  const backupSkills = state.skills.map((skill) => ({ dir: skill.path, existed: fs.existsSync(skill.path), files: treeFiles(skill.path) }));
  if (!options.home && state.service) serviceCommand(loc, state, "stop");
  try {
    if (!state.codexConfigExisted && !toml.trim()) { if (fs.existsSync(loc.codexConfig)) fs.unlinkSync(loc.codexConfig); }
    else atomic(loc.codexConfig, toml);
    if (state.claudeEntry) {
      if (!state.claudeConfigExisted && claude && !Object.keys(claude).length) { if (fs.existsSync(loc.claudeConfig)) fs.unlinkSync(loc.claudeConfig); }
      else if (claude) atomic(loc.claudeConfig, `${JSON.stringify(claude, null, 2)}\n`);
    }
    for (const skill of state.skills) if (fs.existsSync(skill.path)) remove(loc.home, skill.path);
    for (const entry of integration) if (fs.existsSync(entry.path)) fs.unlinkSync(managedFile(loc, entry.path));
    fs.unlinkSync(loc.state);
  } catch (error) {
    for (const { file, data } of backupFiles) {
      if (data === null) { if (fs.existsSync(file)) fs.unlinkSync(file); } else atomic(file, data);
    }
    for (const backup of backupSkills) {
      if (fs.existsSync(backup.dir)) remove(loc.home, backup.dir);
      if (backup.existed) writeTree(backup.dir, backup.files);
    }
    if (!options.home && state.service) {
      try { serviceCommand(loc, state, "start"); } catch (restartError) { error.message += `; service restart failed: ${restartError.message}`; }
    }
    throw error;
  }
  // A running .mjs module can be removed; retain a release only if it contains the CWD
  // or an actual filesystem failure prevents removal.
  const retained = [];
  for (const release of releases) {
    if (process.cwd() === release || process.cwd().startsWith(`${release}${path.sep}`)) retained.push(release);
    else if (fs.existsSync(release)) {
      try { remove(loc.releases, release); }
      catch { retained.push(release); }
    }
  }
  return { ok: true, status: "uninstalled", retainedRuntimeDirectories: retained, retainedData: loc.relay, next: "Reload client configuration when convenient. Tokens, logs, durable watches, and session data were preserved; watcher autostart was removed." };
}

async function probeRelay(loc) {
  const token = read(path.join(loc.relay, "token"))?.toString("utf8").trim();
  if (!token) return { ok: false, reason: "missingToken", next: "Reload Codex desktop MCP configuration so the bridge starts." };
  let pipe;
  try { pipe = process.env.CODEX_RELAY_PIPE || controlPipeFor(loc.relay, loc.platform); }
  catch (error) { return { ok: false, reason: "invalidSocketPath", error: error.message }; }
  return new Promise((resolve) => {
    const socket = net.createConnection(pipe);
    let buffer = "";
    const finish = (value) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), 2_000);
    socket.once("error", (error) => finish({ ok: false, reason: "unreachable", error: error.message }));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: 1, token, method: "relay/info" })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65_536) return finish({ ok: false, reason: "invalidResponse" });
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.split("\n")[0]);
        finish(result.error ? { ok: false, reason: "relayError", error: result.error.message } : { ok: result.result?.appPipe === true, info: result.result });
      } catch { finish({ ok: false, reason: "invalidResponse" }); }
    });
  });
}

export async function inspectInstallation(options = {}) {
  const loc = locations(options);
  const state = json(loc.state);
  if (!state) return { ok: false, status: "notInstalled", stateFile: loc.state, next: "Run scripts/install.mjs install --target both from the source checkout." };
  const checks = [];
  const check = (name, run) => { try { run(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.message }); } };
  check("runtime", () => runtimeInfo(state.runtime));
  check("profile", () => { if (state.codexConfig !== loc.codexConfig || state.claudeConfig !== loc.claudeConfig) throw new Error("Run with the original installation --home / CODEX_HOME"); });
  check("sourceIntegrity", () => { if (!equal(hashes(treeFiles(state.release)), state.sourceHashes)) throw new Error("Installed source differs from the recorded hashes; update from a verified checkout"); });
  check("watcherAutostart", () => {
    if (!state.service || !state.managedFiles?.length) throw new Error("Watcher service integration is missing; rerun install from the current source");
    for (const entry of state.managedFiles) {
      managedFile(loc, entry.path);
      const data = read(entry.path);
      if (data === null || digest(data) !== entry.hash) throw new Error(`Missing or changed watcher integration: ${entry.path}`);
    }
  });
  check("codexConfig", () => {
    const text = read(loc.codexConfig)?.toString("utf8") ?? "";
    for (const [name, expected] of Object.entries(state.configBlocks)) if (findBlock(text, name) !== expected) throw new Error(`Missing or changed ${name} block`);
  });
  for (const skill of state.skills) check(`skill:${skill.path}`, () => { if (!fs.existsSync(skill.path)) throw new Error("Skill is missing"); assertSkill(skill.path, state); });
  if (state.claudeEntry) check("claudeConfig", () => { if (!equal(json(loc.claudeConfig)?.mcpServers?.codex_relay, state.claudeEntry)) throw new Error("Missing or changed Claude MCP entry"); });
  const configured = checks.every((entry) => entry.ok);
  let service = { ok: null, skipped: true, reason: options.offline ? "offline" : options.home ? "isolatedHome" : "notConfigured" };
  if (configured && !options.offline && !options.home) {
    try { const result = serviceCommand(loc, state, "status"); service = { ...result, ok: result.running === true }; }
    catch (error) { service = { ok: false, error: error.message }; }
  }
  const bridge = options.offline ? { ok: null, skipped: true } : await probeRelay(loc);
  let caller = { ok: null, skipped: true };
  if (configured && bridge.ok === true) {
    const probe = spawnSync(state.runtime, [path.join(state.release, "cli.mjs"), "projects"], {
      encoding: "utf8", windowsHide: true, timeout: 8_000,
      env: { ...process.env, CODEX_RELAY_HOME: loc.relay, CODEX_HOME: loc.codex },
    });
    let output;
    try { output = JSON.parse(probe.stdout?.trim()); } catch {}
    const valid = Array.isArray(output);
    caller = { ok: !probe.error && probe.status === 0 && valid, ...(probe.error || probe.status !== 0 || !valid ? { error: probe.error?.message || output?.error || probe.stderr?.trim() || "Caller probe did not return a projects array" } : {}) };
  }
  const ready = configured && bridge.ok === true && caller.ok === true && service.ok !== false;
  const accessDenied = /EPERM|EACCES|permission denied|access (?:is )?denied/i.test(`${bridge.error ?? ""} ${caller.error ?? ""}`);
  return { ok: options.offline ? configured : ready, installed: true, configReady: configured, connected: bridge.ok, callerReady: caller.ok, serviceReady: service.ok,
    status: !configured ? "needsRepair" : bridge.skipped ? "configured" : accessDenied ? "needsAccess" : service.ok === false ? "needsService" : bridge.ok === false ? "pendingReload" : caller.ok === false ? "needsCaller" : "ready",
    checks, bridge, caller, service, runtime: state.runtime, release: state.release, targets: state.targets, mcpTargets: state.mcpTargets, stateFile: loc.state,
    next: !configured ? "Resolve the failed checks; configuration edits are preserved." : accessDenied ? "The host sandbox denied local pipe access. Use the host's normal permission escalation for this authorized command, then rerun doctor. Do not loosen global sandbox or approval settings." : service.ok === false ? "Run the installed daemon.mjs start command, then rerun doctor. Durable watch records were preserved." : bridge.ok === false ? "Reload Codex desktop MCP configuration, then rerun doctor." : bridge.skipped ? "Run doctor without --offline to check the live desktop bridge." : caller.ok === false ? "Ask the user to activate an existing Codex desktop chat and, if needed, send a message. Do not send a message automatically. Then rerun doctor." : "The read-only projects call succeeded; use the installed MCP tools, with CLI available for diagnostics." };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (["help", "--help", "-h"].includes(options.command)) return { ok: true, commands: ["install --target codex|claude|both [--runtime <node-or-bun>] [--no-mcp] [--source <checkout>] [--dry-run]", "update [--source <checkout>] [--ref <git-ref>]", "uninstall [--dry-run]", "doctor [--offline] [--json]"], options: { platform: "--platform win32|darwin|linux selects the autostart layout of an isolated --home, for tests only.", mcp: "Agent-facing MCP and persistent watcher autostart are installed by default. --mcp is a compatibility alias; --no-mcp adds no new MCP targets but preserves existing registrations.", home: "Absolute isolated home for tests or a separate user profile; ignores CODEX_HOME and CODEX_RELAY_HOME and never launches or stops a service" } };
  const loc = locations(options);
  if (options.command === "doctor") return inspectInstallation(options);
  if (!["install", "update", "uninstall"].includes(options.command)) throw new Error(`Unknown command ${options.command}`);
  // withLock is synchronous so all installation mutations are serialized in one process.
  return withLock(loc, () => {
    const state = json(loc.state);
    if (options.command === "uninstall") return uninstall(options, loc, state);
    if (options.command === "install") return installSource(options, loc, options.source ?? SOURCE, state);
    if (!state) throw new Error("No installation found; run install first");
    if (options.source) return installSource(options, loc, options.source, state);
    if (!state.source.url) throw new Error("This installation has no recorded Git origin. Clone the desired version and run update --source <checkout>.");
    const stage = inside(loc.relay, path.join(loc.relay, `update-${crypto.randomUUID()}`));
    fs.mkdirSync(stage);
    try {
      const cloned = spawnSync("git", ["clone", "--no-checkout", "--", state.source.url, stage], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
      if (cloned.error || cloned.status !== 0) throw new Error(`Git clone failed: ${cloned.error?.message || cloned.stderr}`);
      const ref = options.ref ?? state.source.ref ?? "main";
      git(stage, ["checkout", "--detach", ref]);
      const result = installSource({ ...options, ref }, loc, stage, state);
      // Keep the original source location for diagnostics; update staging is removed below.
      if (!options["dry-run"]) {
        const updated = json(loc.state);
        updated.source.path = state.source.path;
        atomic(loc.state, `${JSON.stringify(updated, null, 2)}\n`);
      }
      return result;
    } finally { remove(loc.relay, stage); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await main();
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, status: "error", error: error.message }));
    process.exitCode = 1;
  }
}
