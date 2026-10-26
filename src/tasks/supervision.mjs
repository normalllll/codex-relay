import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { callApp as defaultCallApp, MAX_RECENT_THREADS } from "../desktop/codex-client.mjs";
import { relayHome } from "../runtime/paths.mjs";
import { serviceStatus, startService, daemonRequest } from "../watch/daemon-client.mjs";
import { ReplyOutbox } from "./outbox.mjs";
import { runHostProcess } from "../watch/host-wake.mjs";
import { inspectModelPolicy } from "./model-policy.mjs";
import { resolveTarget, samePath, assertLocalThread } from "./task-target.mjs";
import { discoverProject } from "./project-discovery.mjs";

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
// The executor needs work text; supervision and authorization policy stay with the sender.
const taskPrompt = (task, doneWhen) => [task, doneWhen].join("\n\n");

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
    let projects, threads, allThreads;
    try {
      projects = ((await callApp("list_projects", {})).projects ?? []).filter((item) => !item.hostId || item.hostId === "local");
      const listed = await callApp("list_threads", { limit: MAX_RECENT_THREADS });
      allThreads = [...(listed.pinnedThreads ?? []), ...(listed.threads ?? [])];
      threads = allThreads.filter((item) => item.kind === "codex" && (!item.hostId || item.hostId === "local"));
      check("desktopBridge", true, "Read-only project and session discovery succeeded");
    } catch (error) {
      check("desktopBridge", false, error.message, "Run doctor and resolve bridge access or pending configuration reload. Do not send a test message.");
      return { ready: false, supervisor, checks, blockers, warnings };
    }
    let project;
    if (args.projectPath && !path.isAbsolute(args.projectPath)) check("project", false, "projectPath must be absolute");
    if (args.expectedCwd && !path.isAbsolute(args.expectedCwd)) check("targetDirectory", false, "expectedCwd must be absolute");
    if (args.projectId && args.projectPath) check("project", false, "Specify projectId or projectPath, not both");
    else {
      try {
        const selector = args.projectId ? { projectId: args.projectId, projectPath: context.expectedProjectPath }
          : { projectPath: args.projectPath ?? supervisor.cwd };
        const verifiedThreads = [];
        const registered = context.verifiedProject || projects.some((item) => selector.projectId ? item.projectId === selector.projectId : samePath(item.path, selector.projectPath));
        // Recent results are partial. Inspect the exact explicitly selected chat,
        // or the actual supervisor for implicit selection, before declaring a miss.
        const evidenceId = args.projectId || args.projectPath ? args.threadId : supervisor.host === "codex" ? supervisor.threadId : null;
        if (!registered && evidenceId) {
          const view = await callApp("read_thread", { threadId: evidenceId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
          const thread = view?.thread;
          assertLocalThread(evidenceId, thread);
          if (!args.projectId && !args.projectPath && !samePath(thread.cwd, supervisor.cwd))
            throw new Error("The supervisor working directory does not match its verified chat");
          verifiedThreads.push({ ...thread, kind: "codex" });
        }
        project = await discoverProject(selector, { callApp, projects, threads: allThreads, verifiedThreads, binding: context.expectedTarget, verifiedProject: context.verifiedProject });
        check("projectSelection", true, project.discovery ?? "The selected local project is registered");
      } catch (error) {
        check("projectSelection", false, error.message,
          "Specify the intended project and verify its exact existing local chat identity and directory; never substitute another project.");
      }
    }
    if (project && args.createNew && !args.worktree && args.expectedCwd)
      check("targetDirectory", samePath(args.expectedCwd, project.path), "A local execution must use the selected project working directory");
    if (project && context.expectedProjectPath)
      check("projectIdentity", samePath(project.path, context.expectedProjectPath), "The bound project path changed; inspect the original project before retrying");
    let selected, target;
    if (args.threadId && args.threadTitle) check("target", false, "Specify threadId or threadTitle, not both");
    else if (args.threadTitle) {
      const candidates = threads.filter((item) => item.title === args.threadTitle && (!project || !item.projectId || item.projectId === project.projectId));
      const matches = [];
      for (const candidate of candidates) {
        if (candidate.projectId || !project) { matches.push(candidate); continue; }
        try {
          const view = await callApp("read_thread", { threadId: candidate.id, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
          assertLocalThread(candidate.id, view?.thread);
          // Excluding a confirmed member of another project needs no inference
          // about that project's root (which may itself be omitted or a worktree).
          if (view.thread.projectId && view.thread.projectId !== project.projectId) continue;
          const identity = await resolveTarget(candidate.id, { callApp, projects, threads: allThreads, verifiedProject: project,
            expected: { projectId: project.projectId, projectPath: project.path } });
          if (identity.projectId === project.projectId) matches.push(candidate);
        } catch (error) {
          check("targetIdentity", false, error.message, "Inspect the exact same-title candidate; missing project metadata does not select a replacement.");
        }
      }
      if (check("targetSelection", matches.length === 1, matches.length ? "The exact title is ambiguous" : "No exact matching execution chat was found", "Resolve the exact intended chat; ask only if the user's selection is ambiguous.")) selected = matches[0];
    } else if (args.threadId) selected = threads.find((item) => item.id === args.threadId) ?? { id: args.threadId };
    if (selected) {
      if (check("separateExecution", supervisor.host !== "codex" || selected.id !== supervisor.threadId, "The current supervisor and execution chat must be different")) {
        try {
          target = await resolveTarget(selected.id, { callApp, projects, threads: allThreads, verifiedProject: project, createdThreadId: context.createdThreadId,
            expected: { ...context.expectedTarget, ...(project ? { projectId: project.projectId, projectPath: project.path } : {}),
              ...(args.expectedCwd ? { cwd: args.expectedCwd } : {}) } });
          check("executionChat", true, "The selected execution chat is accessible");
        } catch (error) { check("executionChat", false, error.message, "Inspect the selected chat without substituting a recent chat."); }
      }
    }
    if (args.createNew || target) {
      const policy = await modelPolicy({ threadId: target?.threadId, projectPath: project?.path,
        readThread: () => callApp("read_thread", { threadId: target.threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }) });
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
      target, checks, blockers, warnings, modelPolicy: "standardOnly" };
  }

  async function supervise(args, context = {}) {
    if (typeof args.requestId !== "string" || !args.requestId.trim() || args.requestId.length > 160) throw new Error("requestId must contain 1..160 characters");
    if (typeof args.task !== "string" || !args.task.trim() || typeof args.doneWhen !== "string" || !args.doneWhen.trim()) throw new Error("task and doneWhen are required");
    if ([args.createNew === true, Boolean(args.threadId), Boolean(args.threadTitle)].filter(Boolean).length !== 1)
      throw new Error("Select exactly one execution target: createNew:true, threadId, or threadTitle");
    const receiptId = `supervise:${args.requestId}`;
    outbox.assertInput(receiptId, args);
    const previous = outbox.inspect(receiptId);
    if (previous.result) return { ...await outbox.execute(receiptId, args, () => { throw new Error("Completed operation unexpectedly lost its receipt"); }), receiptId, requestId: args.requestId };
    const existingPlan = previous.stages?.plan?.result;
    if (existingPlan && (!existingPlan.project?.projectId || !existingPlan.project?.path))
      return { status: "blocked", ready: false, requestId: args.requestId, blockers: [{ code: "legacyProjectBinding",
        message: "The saved supervision plan has no verified project binding; its receipt was preserved",
        nextAction: "Inspect the original executor and delivery stages, then explicitly register its intended project. Do not replace the executor or reuse this requestId with changed input." }] };
    const boundTarget = previous.stages?.target?.result ?? existingPlan?.target;
    const createdThreadId = previous.stages?.create?.result?.threadId;
    const retryArgs = existingPlan ? { ...args, supervisor: existingPlan.supervisor, projectId: existingPlan.project.projectId,
      projectPath: undefined, ...(boundTarget || createdThreadId ? { createNew: false, threadTitle: undefined,
        threadId: boundTarget?.threadId ?? createdThreadId, expectedCwd: boundTarget?.cwd ?? args.expectedCwd } : {}) } : args;
    // A title is only a discovery selector. Once persisted, validate the bound ID and project on every retry.
    const prepared = await preflight(retryArgs, { ...context, expectedTarget: boundTarget,
      expectedProjectPath: existingPlan?.project.path, verifiedProject: existingPlan?.project, createdThreadId });
    if (!prepared.ready) return { status: "blocked", requestId: args.requestId, ...prepared };
    try {
      const result = await outbox.execute(receiptId, args, async (transaction) => {
        const plan = await transaction.stage("plan", async () => prepared, { replaySafe: true });
        try { await ensureService({ resume: true }); }
        catch (error) { error.delivery = "notSent"; throw error; }
        let threadId = plan.target?.threadId;
        if (args.createNew) {
          const created = await transaction.stage("create", () => callApp("create_thread", {
            prompt: taskPrompt(args.task, args.doneWhen), ...(args.title ? { title: args.title } : {}),
            target: { type: "project", projectId: plan.project.projectId, environment: { type: args.worktree ? "worktree" : "local" } },
          }));
          threadId = created.threadId ?? boundTarget?.threadId;
          if (!threadId && created.clientThreadId) {
            const listed = await callApp("list_threads", { limit: MAX_RECENT_THREADS });
            const matches = [...(listed.pinnedThreads ?? []), ...(listed.threads ?? [])].filter((item) => item.kind === "codex" &&
              (!item.hostId || item.hostId === "local") && item.clientThreadId === created.clientThreadId);
            const ids = [...new Set(matches.map((item) => item.id))];
            if (ids.length > 1) throw new Error("Pending creation resolved to multiple chats; inspect the exact creation before continuing");
            threadId = ids[0];
          }
          if (!threadId) throw Object.assign(new Error("Execution chat setup is pending. Repeat this supervise request with identical input; do not create another chat."), { code: "SETUP_PENDING", pendingClientThreadId: created.clientThreadId });
        }
        const target = args.createNew ? await resolveTarget(threadId, { callApp, verifiedProject: plan.project, createdThreadId: threadId,
          expected: { ...boundTarget, projectId: plan.project.projectId, projectPath: plan.project.path,
            ...(args.expectedCwd ? { cwd: args.expectedCwd } : {}), ...(!args.worktree ? { cwd: plan.project.path } : {}) } }) : prepared.target;
        if (args.createNew) {
          const policy = await modelPolicy({ threadId, projectPath: plan.project.path,
            readThread: () => callApp("read_thread", { threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }) });
          if (!policy.ok) throw Object.assign(new Error(policy.reason ?? "The created execution chat must use Standard mode"), { delivery: "notSent" });
        }
        plan.target = target;
        await transaction.stage("target", async () => target, { replaySafe: true });
        const subscription = await subscribe({ id: `supervise_${key(receiptId)}`, threadId, target, supervisor: plan.supervisor,
          goal: { task: args.task, doneWhen: args.doneWhen }, policy: { noFast: true }, workflowRequestId: args.requestId });
        if (!args.createNew) {
          if (!sendReply) throw new Error("The supervision sender was not configured");
          await sendReply({ subscriptionId: subscription.id, threadId, requestId: `${receiptId}:instruction`, message: taskPrompt(args.task, args.doneWhen) });
        }
        return { status: "watching", ready: true, threadId, target, subscriptionId: subscription.id, supervisor: subscription.supervisor,
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
