import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { callApp as defaultCallApp } from "./codex-client.mjs";
import { relayHome } from "./paths.mjs";
import { serviceStatus, startService, daemonRequest } from "./daemon-client.mjs";
import { ReplyOutbox } from "./outbox.mjs";
import { runHostProcess } from "./host-wake.mjs";
import { inspectModelPolicy } from "./model-policy.mjs";

export function hostIdentity(env = process.env, cwd = process.cwd()) {
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  const codex = env.CODEX_THREAD_ID?.trim();
  if (claude) return { host: "claude", sessionId: claude, cwd, fastDisabled: env.CLAUDE_CODE_DISABLE_FAST_MODE === "1" };
  if (codex && !env.CLAUDECODE) return { host: "codex", threadId: codex, cwd };
  return { host: null, cwd, nextAction: "Run the installed CLI host command in the current agent's shell and pass its actual identity as supervisor. Never guess from recent chats." };
}

export function discoverExecutable(host, env = process.env) {
  const override = env[host === "codex" ? "CODEX_RELAY_CODEX_EXECUTABLE" : "CODEX_RELAY_CLAUDE_EXECUTABLE"];
  const names = process.platform === "win32" ? [`${host}.exe`] : [host];
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).map((dir) => dir.replace(/^"|"$/g, "")).filter(Boolean);
  // A login-started watcher (launchd, XDG autostart) may receive a minimal PATH; add the usual user
  // install locations. Every discovered executable is still capability-probed before use.
  if (process.platform !== "win32" && env.HOME) dirs.push(path.join(env.HOME, ".local", "bin"), path.join(env.HOME, ".npm-global", "bin"),
    ...(host === "claude" ? [path.join(env.HOME, ".claude", "local")] : []), "/opt/homebrew/bin", "/usr/local/bin");
  if (host === "codex" && process.platform === "darwin")
    dirs.push("/Applications/Codex.app/Contents/Resources", ...(env.HOME ? [path.join(env.HOME, "Applications", "Codex.app", "Contents", "Resources")] : []));
  const candidates = [override, ...dirs.flatMap((dir) => names.map((name) => path.join(dir, name)))];
  if (host === "codex" && process.platform === "win32" && env.LOCALAPPDATA) {
    const bin = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    try {
      candidates.push(...fs.readdirSync(bin).map((name) => path.join(bin, name, "codex.exe"))
        .filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs));
    } catch {}
  }
  return candidates.find((file) => {
    try { return file && path.isAbsolute(file) && fs.statSync(file).isFile(); } catch { return false; }
  }) ?? null;
}

export async function probeHost(host, executable, { run = runHostProcess, cwd } = {}) {
  if (!executable || !path.isAbsolute(executable)) return { ok: false, reason: "No absolute host executable was discovered" };
  try {
    const result = await run(executable, host === "codex" ? ["queue", "--help"] : ["--help"],
      { cwd, input: "", timeoutMs: 5_000, label: `${host} capability check` });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const ok = result.code === 0 && (host === "codex" ? /--thread\b/.test(text) && /--message\b/.test(text)
      : /--resume\b/.test(text) && /--print\b/.test(text) && /--settings\b/.test(text));
    return { ok, executable, reason: ok ? undefined : "The installed host does not expose the required command options" };
  } catch (error) { return { ok: false, executable, reason: error.message }; }
}

const key = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const taskPrompt = (task, doneWhen) => [
  "[Delegated execution under Codex Relay supervision]", task,
  "Completion criteria:", doneWhen,
  "Use the existing model and reasoning settings in Standard mode. Do not enable Fast, priority, or Ultrafast mode.",
  "Continue within the authorized task. Report concrete results and verification against the completion criteria. Ask when a decision exceeds that scope.",
].join("\n\n");

export function createSupervision({ callApp = defaultCallApp, modelPolicy = inspectModelPolicy, identity = hostIdentity,
  discover = discoverExecutable, probe = probeHost, getService = serviceStatus, ensureService = startService,
  subscribe = (input) => daemonRequest("subscribe", input), sendReply,
  outbox = new ReplyOutbox(relayHome) } = {}) {
  async function preflight(args = {}, context = {}) {
    const checks = [], blockers = [], warnings = [];
    const check = (name, ok, details, nextAction) => {
      checks.push({ name, ok, details });
      if (!ok) blockers.push({ code: name, message: typeof details === "string" ? details : details?.reason, nextAction });
      return ok;
    };
    const detected = context.fromMcp && args.supervisor ? args.supervisor : identity();
    if (context.fromMcp && !args.supervisor) {
      check("currentHost", false, "A shared MCP process cannot attest the calling conversation's identity", "Run installed CLI host in the current agent shell and pass host/threadId or sessionId, cwd and fastDisabled as supervisor. This is agent discovery, not a question for the user.");
      return { ready: false, checks, blockers, warnings };
    }
    const supervisor = { ...(args.supervisor ?? detected) };
    if (!check("currentHost", ["codex", "claude"].includes(supervisor.host) && Boolean(supervisor.host === "codex" ? supervisor.threadId : supervisor.sessionId),
      "A real supervising session identity is required", "Read CLI host in the current agent shell, then retry with that identity."))
      return { ready: false, checks, blockers, warnings };
    let projects, threads;
    try {
      projects = (await callApp("list_projects", {})).projects ?? [];
      const listed = await callApp("list_threads", { limit: 100 });
      threads = [...(listed.pinnedThreads ?? []), ...(listed.threads ?? [])].filter((item) => item.kind === "codex");
      check("desktopBridge", true, "Read-only project and session discovery succeeded");
    } catch (error) {
      check("desktopBridge", false, error.message, "Run doctor and resolve bridge access or pending configuration reload. Do not send a test message.");
      return { ready: false, supervisor, checks, blockers, warnings };
    }
    let project;
    if (args.projectPath && !path.isAbsolute(args.projectPath)) check("project", false, "projectPath must be absolute");
    if (args.projectId && args.projectPath) check("project", false, "Specify projectId or projectPath, not both");
    else if (args.projectId) project = projects.find((item) => item.projectId === args.projectId);
    else if (args.projectPath) project = projects.find((item) => item.path && path.resolve(item.path).toLowerCase() === path.resolve(args.projectPath).toLowerCase());
    else if (supervisor.cwd) project = projects.find((item) => item.path && path.resolve(item.path).toLowerCase() === path.resolve(supervisor.cwd).toLowerCase());
    let target;
    if (args.threadId && args.threadTitle) check("target", false, "Specify threadId or threadTitle, not both");
    else if (args.threadTitle) {
      const matches = threads.filter((item) => item.title === args.threadTitle && (!project || item.projectId === project.projectId));
      if (check("targetSelection", matches.length === 1, matches.length ? "The exact title is ambiguous" : "No exact matching execution chat was found", "Resolve the exact intended chat; ask only if the user's selection is ambiguous.")) target = matches[0];
    } else if (args.threadId) target = threads.find((item) => item.id === args.threadId) ?? { id: args.threadId };
    let targetView;
    if (target) {
      if (check("separateExecution", supervisor.host !== "codex" || target.id !== supervisor.threadId, "The current supervisor and execution chat must be different")) {
        try {
          targetView = await callApp("read_thread", { threadId: target.id, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
          if (!targetView?.thread || targetView.thread.id !== target.id) throw new Error("The execution chat identity was not confirmed");
          if (project && ((target.projectId && target.projectId !== project.projectId) ||
            (!target.projectId && targetView.thread.cwd && project.path && path.resolve(targetView.thread.cwd).toLowerCase() !== path.resolve(project.path).toLowerCase())))
            throw new Error("The selected execution chat does not belong to the requested project");
          check("executionChat", true, "The selected execution chat is accessible");
          if (!args.projectId && !args.projectPath) project ??= projects.find((item) => item.projectId === target.projectId || (targetView.thread.cwd && item.path && path.resolve(item.path).toLowerCase() === path.resolve(targetView.thread.cwd).toLowerCase()));
        } catch (error) { check("executionChat", false, error.message, "Inspect the selected chat without substituting a recent chat."); }
      }
    }
    if (args.createNew || args.projectPath || args.projectId) check("projectSelection", Boolean(project), "An exact existing Codex project is required", "Use the current project or resolve the user's named project. Do not create a replacement project.");
    if (args.createNew || target) {
      const policy = await modelPolicy({ threadId: target?.id, projectPath: project?.path,
        readThread: async () => targetView ?? callApp("read_thread", { threadId: target.id, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }) });
      check("executionStandardMode", policy.ok, policy, policy.nextAction);
    }
    const service = await getService();
    if (supervisor.host === "codex") {
      const mode = supervisor.mode ?? "auto";
      const policy = await modelPolicy({ threadId: supervisor.threadId, readThread: () => callApp("read_thread", { threadId: supervisor.threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }) });
      check("supervisorStandardMode", policy.ok, policy, policy.nextAction);
      if (!["auto", "queue", "desktop"].includes(mode)) check("wakeMode", false, "Invalid Codex wake mode");
      else {
        const executable = supervisor.executable ?? discover("codex");
        const capability = mode === "desktop" ? { ok: false } : await probe("codex", executable, { cwd: supervisor.cwd });
        if (mode !== "desktop" && capability.ok) Object.assign(supervisor, { mode: "queue", executable });
        else if (mode === "queue") check("wakeCapability", false, capability.reason, "Use a Codex executable exposing queue --thread --message, or an available Standard desktop supervisor.");
        else {
          supervisor.mode = "desktop";
          const loaded = threads.find((item) => item.id === supervisor.threadId && item.status !== "notLoaded");
          check("supervisorLoaded", Boolean(loaded), "Desktop fallback requires the current supervisor to be loaded", "Keep that supervisor available or provide a supported Codex CLI.");
          warnings.push("Desktop wake is selected from read-only availability checks; delivery permission is confirmed only by a real event, not a probe message.");
        }
      }
    } else {
      let mode = supervisor.mode ?? "auto";
      if (mode === "auto" && detected.host && (detected.host !== "claude" || detected.sessionId !== supervisor.sessionId)) mode = "resume";
      const connected = service.channelSessions?.includes(supervisor.sessionId);
      if ((mode === "auto" || mode === "channel") && connected) {
        supervisor.mode = "channel";
        check("supervisorStandardMode", supervisor.fastDisabled === true, "The live Claude parent must have Fast mode disabled", "Read CLI host in that session. Launch Claude with CLAUDE_CODE_DISABLE_FAST_MODE=1 if necessary; an MCP child cannot change the parent.");
      } else if (mode === "channel" || mode === "auto") {
        check("claudeLiveChannel", false, "The current Claude supervisor has no connected, explicitly enabled channel", "Enable the Relay channel through the host's trust flow and bind the actual current session. Do not start a competing resume writer.");
      } else if (mode === "resume") {
        const executable = supervisor.executable ?? discover("claude");
        const capability = await probe("claude", executable, { cwd: supervisor.cwd });
        check("wakeCapability", capability.ok, capability.reason ?? "Claude resume options are available", "Locate a supported Claude executable.");
        check("resumeDirectory", Boolean(supervisor.cwd && path.isAbsolute(supervisor.cwd) && fs.statSync(supervisor.cwd, { throwIfNoEntry: false })?.isDirectory()), "Claude resume requires its actual existing working directory");
        if (detected.host === "claude" && detected.sessionId === supervisor.sessionId)
          check("resumeSessionIdle", false, "The current interactive Claude session cannot also be resumed by a second writer", "Use its live channel, or an explicitly selected idle saved supervisor.");
        Object.assign(supervisor, { mode: "resume", executable });
      } else check("wakeMode", false, "Invalid Claude wake mode");
    }
    check("watchService", true, service.running ? "Background service is running" : "The authorized setup will start the background service before dispatch");
    warnings.push("Read-only checks cannot establish future authentication, model quota, network availability, or a served service-tier receipt. No test message was sent.");
    return { ready: blockers.length === 0, supervisor, project: project ? { projectId: project.projectId, path: project.path } : undefined,
      target: target ? { threadId: target.id, title: target.title } : undefined, checks, blockers, warnings, modelPolicy: "standardOnly" };
  }

  async function supervise(args, context = {}) {
    if (typeof args.requestId !== "string" || !args.requestId.trim() || args.requestId.length > 160) throw new Error("requestId must contain 1..160 characters");
    if (typeof args.task !== "string" || !args.task.trim() || typeof args.doneWhen !== "string" || !args.doneWhen.trim()) throw new Error("task and doneWhen are required");
    if ([args.createNew === true, Boolean(args.threadId), Boolean(args.threadTitle)].filter(Boolean).length !== 1)
      throw new Error("Select exactly one execution target: createNew:true, threadId, or threadTitle");
    const receiptId = `supervise:${args.requestId}`;
    const previous = outbox.inspect(receiptId);
    if (previous.result) return { ...await outbox.execute(receiptId, args, () => { throw new Error("Completed operation unexpectedly lost its receipt"); }), receiptId, requestId: args.requestId };
    const existingPlan = previous.stages?.plan?.result;
    const prepared = await preflight(existingPlan ? { ...args, supervisor: existingPlan.supervisor,
      ...(previous.stages?.create?.result?.threadId ? { createNew: false, threadId: previous.stages.create.result.threadId } : {}) } : args, context);
    if (!prepared.ready) return { status: "blocked", requestId: args.requestId, ...prepared };
    try {
      const result = await outbox.execute(receiptId, args, async (transaction) => {
        const plan = await transaction.stage("plan", async () => prepared);
        try { await ensureService({ resume: true }); }
        catch (error) { error.delivery = "notSent"; throw error; }
        let threadId = plan.target?.threadId;
        if (args.createNew) {
          const created = await transaction.stage("create", () => callApp("create_thread", {
            prompt: taskPrompt(args.task, args.doneWhen), ...(args.title ? { title: args.title } : {}),
            target: { type: "project", projectId: plan.project.projectId, environment: { type: args.worktree ? "worktree" : "local" } },
          }));
          threadId = created.threadId;
          if (!threadId && created.clientThreadId) {
            const listed = await callApp("list_threads", { limit: 100 });
            threadId = [...(listed.pinnedThreads ?? []), ...(listed.threads ?? [])].find((item) => item.kind === "codex" && item.clientThreadId === created.clientThreadId)?.id;
          }
          if (!threadId) throw Object.assign(new Error("Execution chat setup is pending. Repeat this supervise request with identical input; do not create another chat."), { code: "SETUP_PENDING", pendingClientThreadId: created.clientThreadId });
        }
        const subscription = await subscribe({ id: `supervise_${key(receiptId)}`, threadId, supervisor: plan.supervisor,
          goal: { task: args.task, doneWhen: args.doneWhen }, policy: { noFast: true }, workflowRequestId: args.requestId });
        if (!args.createNew) {
          if (!sendReply) throw new Error("The supervision sender was not configured");
          await sendReply({ threadId, requestId: `${receiptId}:instruction`, message: taskPrompt(args.task, args.doneWhen) });
        }
        return { status: "watching", ready: true, threadId, subscriptionId: subscription.id, supervisor: subscription.supervisor,
          task: args.task, doneWhen: args.doneWhen, modelPolicy: "standardOnly", warnings: plan.warnings };
      });
      return { ...result, receiptId, requestId: args.requestId };
    } catch (error) {
      if (error.code === "SETUP_PENDING") return { status: "pending", requestId: args.requestId, pendingClientThreadId: error.pendingClientThreadId, nextAction: error.message };
      throw error;
    }
  }
  return { preflight, supervise };
}
