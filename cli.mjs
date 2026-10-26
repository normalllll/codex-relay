import fs from "node:fs";
import { fileURLToPath } from "node:url";

const commands = {
  projects: "codex_projects", threads: "codex_threads", start: "codex_start", status: "codex_status",
  wait: "codex_wait", reply: "codex_reply", resolve: "codex_resolve",
  watch: "codex_watch", watches: "codex_watches", events: "codex_events", ack: "codex_watch_ack", unwatch: "codex_unwatch",
  delivery: "codex_delivery",
  preflight: "codex_preflight", supervise: "codex_supervise",
  "event-context": "codex_event_context", "event-report": "codex_event_report",
};
const valueFlags = {
  "--project": "projectPath", "--project-id": "projectId", "--title": "title", "--limit": "limit",
  "--timeout-minutes": "timeoutMinutes", "--prompt": "prompt", "--message": "message", "--request-id": "requestId", "--answer-source": "answerSource",
};
const boolFlags = { "--worktree": "worktree", "--past-attention": "pastAttention", "--user-provided": "userProvided", "--allow-open": "allowOpen" };

export const help = {
  name: "codex-relay", version: "0.6.0", output: "One JSON result on stdout; errors have ok:false and exit code 1. Help is JSON too.",
  execution: "Run this file directly with the absolute Node or Bun executable. No build, package install, or global PATH changes.",
  commands: {
    projects: "projects [--project <absolute-path> | --project-id <id>] (verify one project, including catalogue omissions)",
    threads: "threads [--project <absolute-path>] [--limit 1..50]",
    start: "start (--project <absolute-path> | --project-id <id>) --prompt-file <UTF-8-file> [--title <text>] [--worktree]",
    status: "status <threadId>",
    wait: "wait <threadId> [--timeout-minutes 0..60] [--past-attention] (run in background for long waits)",
    reply: "reply [<threadId>] --input-file <JSON-file>; supervised JSON uses subscriptionId or eventId; standalone requires --project <absolute-path> or --project-id <id>; optional JSON expectedCwd asserts workspace",
    resolve: "resolve <pendingClientThreadId> [--project <absolute-path> | --project-id <id>] (uses saved creation binding; legacy pending IDs require an explicit project)",
    info: "info (read-only bridge connectivity)",
    host: "host (read current host/session environment for watch registration; never guesses a session)",
    preflight: "preflight --input-file <JSON target/project/current supervisor> (read-only unattended readiness)",
    supervise: "supervise --input-file <JSON {requestId,task,doneWhen,createNew:true or threadId or threadTitle,projectPath?,supervisor?}> (automatic check/create/select/watch)",
    watch: "watch --input-file <JSON {threadId,projectPath or projectId,expectedCwd?,supervisor:{host,threadId or sessionId,mode,cwd,executable}}> (MCP codex_watch is primary)",
    watches: "watches", events: "events --input-file <JSON {subscriptionId,includeAcknowledged?}>",
    "event-context": "event-context --input-file <JSON {eventId,previewChars?}> (one compact event and current-state read)",
    "event-report": "event-report --input-file <JSON {eventId,section?,offset?,limit?,reportHash?}> (read full report only when needed)",
    ack: "ack --input-file <JSON {eventId,action:rearm|complete|retry}>", unwatch: "unwatch --input-file <JSON {subscriptionId}>",
    service: "service start|stop|status (persistent background watcher control)",
    delivery: "delivery --request-id <id> (inspect persistent send stages)",
    install: "install [--target codex|claude|both] [--runtime <executable>] [--mcp] [--home <isolated-home>]",
    doctor: "doctor [--json] [--offline] [--home <isolated-home>]",
    update: "update [--source <checkout>] [--ref <git-ref>]",
    uninstall: "uninstall [--home <isolated-home>]",
  },
  notes: [
    "Install requires a local Codex desktop app. Windows is tested live; macOS and Linux are implemented but untested with a live desktop. The source runs on Node >=22.16 or Bun >=1.2.",
    "Installation configures the desktop bridge, primary MCP tools, and a persistent watcher with login recovery.",
    "Never retry start/reply after an uncertain transport failure without checking status/threads first.",
    "Use resolve when start returns pendingClientThreadId; do not pass a pending ID to status or wait.",
    "Resolve routine answers within the agreed task scope; request new scope in the supervising chat. Host command approvals stay in Codex.",
  ],
};

export function parseToolArguments(command, argv) {
  const args = {};
  const positional = [];
  let input;
  const set = (key, value) => {
    if (Object.hasOwn(args, key)) throw new Error(`Duplicate argument ${key}`);
    args[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") continue;
    if (boolFlags[flag]) { set(boolFlags[flag], true); continue; }
    if (valueFlags[flag] || flag === "--prompt-file" || flag === "--input-file") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--input-file") {
        if (input !== undefined) throw new Error("Only one --input-file is allowed");
        input = JSON.parse(fs.readFileSync(value, "utf8").replace(/^\uFEFF/, ""));
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input file must contain a JSON object");
      } else if (flag === "--prompt-file") set("prompt", fs.readFileSync(value, "utf8").replace(/^\uFEFF/, ""));
      else set(valueFlags[flag], ["--limit", "--timeout-minutes"].includes(flag) ? Number(value) : value);
      continue;
    }
    if (flag.startsWith("-")) throw new Error(`Unknown option ${flag}`);
    positional.push(flag);
  }
  if (input) for (const [key, value] of Object.entries(input)) set(key, value);
  if (command === "reply") {
    if (positional.length > 1) throw new Error("reply accepts at most one threadId");
    if (positional.length) set("threadId", positional[0]);
    if (!args.threadId && !args.subscriptionId && !args.eventId) throw new Error("reply requires threadId, subscriptionId, or eventId");
  } else if (["status", "wait", "resolve"].includes(command)) {
    if (positional.length !== 1) throw new Error(`${command} requires exactly one ${command === "resolve" ? "pendingClientThreadId" : "threadId"}`);
    set(command === "resolve" ? "clientThreadId" : "threadId", positional[0]);
  } else if (positional.length) throw new Error(`Unexpected argument ${positional[0]}`);
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "help", ...rest] = argv;
  if (["help", "--help", "-h"].includes(command) || rest.includes("--help")) return help;
  if (command === "--version" || command === "version") return { version: help.version, runtime: process.versions.bun ? "bun" : "node" };
  if (["install", "update", "uninstall", "doctor"].includes(command)) {
    const { main: install } = await import("./scripts/install.mjs");
    return install([command, ...rest]);
  }
  if (command === "service") return (await import("./daemon.mjs")).main(rest);
  if (command === "host") return { ...(await import("./src/tasks/supervision.mjs")).hostIdentity(), codexThreadId: process.env.CODEX_THREAD_ID ?? null,
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, cwd: process.cwd(), runtime: process.execPath,
    next: "Use the actual supervisor identifier; Claude session ID is available in its Bash/PowerShell subprocess environment." };
  if (command === "info") {
    if (rest.some((item) => item !== "--json")) throw new Error("info takes no arguments");
    return (await import("./src/desktop/transport.mjs")).relay("relay/info", undefined, { timeoutMs: 3_000 });
  }
  const tool = commands[command];
  if (!tool) throw new Error(`Unknown command ${command}. Run help for exact syntax.`);
  const args = parseToolArguments(command, rest);
  return (await import("./src/tasks/tools.mjs")).runTool(tool, args);
}

// Module URLs resolve directory aliases, while argv can retain the user's entry path.
// Resolve with the OS instead of walking potentially unreadable ancestor directories.
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync.native(fileURLToPath(import.meta.url)) === fs.realpathSync.native(process.argv[1])) {
  try {
    const result = await main();
    console.log(JSON.stringify(result));
    if (result?.ok === false) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message, requestId: error.requestId, delivery: error.delivery, modelPolicy: error.modelPolicy, ...(error.code ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
