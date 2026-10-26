import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relayHome, codexHome } from "../runtime/paths.mjs";
import { isMissingProcess } from "../runtime/process-state.mjs";

const defaultMcpPath = fileURLToPath(new URL("../../mcp.mjs", import.meta.url));
const MAX_OUTPUT = 1024 * 1024;
export const followupTools = ["codex_event_context", "codex_event_report", "codex_events", "codex_status", "codex_reply", "codex_watch_ack", "codex_delivery"];

export function wakeError(message, delivery = "notSent", cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { delivery });
}

function identifier(value, name) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("-") || /[\r\n\0]/.test(value) || value.length > 300)
    throw wakeError(`${name} must be a nonempty identifier without control characters or a leading dash`);
  return value;
}

export function buildWakePrompt(subscription, event) {
  identifier(event?.id, "event.id");
  const subscriptionId = identifier(event.subscriptionId ?? subscription.id, "subscriptionId");
  const type = identifier(event.type, "event.type");
  return JSON.stringify({ relayEvent: 1, eventId: event.id, subscriptionId, type });
}

function classify(error) {
  if (error?.delivery === "notSent" || error?.delivery === "uncertain") return error;
  const message = error?.message ?? String(error);
  const definite = /ENOENT|ECONNREFUSED|EPERM|EACCES|token is missing|no loaded Codex thread|no candidates|thread not loaded|native ancestor|calling thread/i.test(message);
  return wakeError(message, definite ? "notSent" : "uncertain", error);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isMissingProcess(error); }
}

function sessionLease(home, sessionId) {
  const dir = path.join(home, "wake-locks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`);
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      fs.closeSync(descriptor);
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      if (error.code !== "EEXIST") throw classify(error);
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { throw wakeError("A Claude resume lock is incomplete; inspect it before retrying"); }
      if (processAlive(owner.pid)) throw wakeError("Another Relay process is resuming this Claude session");
      // Dead owners cannot release their lock. Recheck its token before stale recovery.
      try { if (JSON.parse(fs.readFileSync(file, "utf8")).token === owner.token) fs.unlinkSync(file); }
      catch (failure) { if (failure.code !== "ENOENT") throw classify(failure); }
    }
  }
  throw wakeError("Could not acquire the Claude session resume lock");
}

export function runHostProcess(executable, args, { input, cwd, env, timeoutMs = 10 * 60_000, signal, label = "Host command" } = {}) {
  if (signal?.aborted) return Promise.reject(wakeError(`${label} cancelled before process start`, "notSent"));
  return new Promise((resolve, reject) => {
    let child;
    let started = false;
    let settled = false;
    let terminationError;
    let stdout = "", stderr = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(result);
    };
    const stop = (message, cause) => {
      if (settled) return;
      terminationError ??= wakeError(message, started || child?.pid ? "uncertain" : "notSent", cause);
      // Keep the caller's session lease until close confirms the process has exited.
      // A failed kill must not release the lease and allow a second resume in parallel.
      try { child?.kill(); }
      catch (error) { terminationError = wakeError(`${label} could not be stopped: ${error.message}`, "uncertain", error); }
    };
    const onAbort = () => stop(`${label} cancelled; delivery may have happened. Inspect the event before retrying.`);
    const timer = setTimeout(() => stop(`${label} timed out; delivery may have happened. Inspect the event before retrying.`), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      child.once("spawn", () => { started = true; if (terminationError) stop(terminationError.message); });
      child.on("error", (error) => {
        if (!started) finish(wakeError(`Cannot start ${label}: ${error.message}`, "notSent", error));
        else stop(`${label} failed: ${error.message}`, error);
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const collect = (target) => (chunk) => {
        if (target === "stdout") stdout += chunk; else stderr += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT) {
          stop(`${label} output exceeded its limit; inspect event delivery before retrying`);
        }
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      child.stdin.on("error", (error) => stop(`${label} input failed: ${error.message}`, error));
      child.once("close", (code, processSignal) => finish(terminationError, { code, signal: processSignal, stdout, stderr }));
      child.stdin.end(input ?? "");
    } catch (error) { finish(wakeError(`Cannot start ${label}: ${error.message}`, "notSent", error)); }
  });
}

export function createWakeHost({ callApp, sendChannel, run = runHostProcess, home = relayHome, runtime = process.execPath, mcpPath = defaultMcpPath, signal: defaultSignal } = {}) {
  const queueCapabilities = new Set();
  return async function wake(subscription, event, { signal = defaultSignal } = {}) {
    if (signal?.aborted) throw wakeError("Host wake cancelled before delivery", "notSent");
    const supervisor = subscription?.supervisor;
    if (!supervisor || !["codex", "claude"].includes(supervisor.host)) throw wakeError("A supported supervisor host is required");
    const prompt = buildWakePrompt(subscription, event);
    if (supervisor.host === "codex") {
      const threadId = identifier(supervisor.threadId, "supervisor.threadId");
      if (threadId === subscription.threadId) throw wakeError("A monitored Codex thread cannot supervise itself");
      const mode = supervisor.mode ?? "desktop";
      if (mode === "queue") {
        const executable = supervisor.executable;
        if (typeof executable !== "string" || !path.isAbsolute(executable) || /[\r\n\0]/.test(executable))
          throw wakeError("Codex queue mode requires an absolute supervisor.executable path to the Codex CLI");
        let stat;
        try { stat = fs.statSync(executable); }
        catch (error) { throw wakeError(`Cannot inspect the Codex executable: ${error.message}`, "notSent", error); }
        if (!stat.isFile()) throw wakeError("Codex supervisor.executable is not a file");
        if (supervisor.cwd && (!path.isAbsolute(supervisor.cwd) || !fs.statSync(supervisor.cwd, { throwIfNoEntry: false })?.isDirectory()))
          throw wakeError("Codex supervisor.cwd must be an existing absolute directory when provided");
        const env = { ...process.env, CODEX_HOME: codexHome, CODEX_RELAY_HOME: path.resolve(home) };
        const options = { cwd: supervisor.cwd, env, timeoutMs: 30_000, signal, label: "Codex queue" };
        const key = `${executable}\0${stat.mtimeMs}\0${stat.size}`;
        if (!queueCapabilities.has(key)) {
          let probe;
          try { probe = await run(executable, ["queue", "--help"], { ...options, input: "", label: "Codex queue capability check" }); }
          catch (error) { throw wakeError(`Codex queue capability check failed: ${error.message}`, "notSent", error); }
          const usage = `${probe?.stdout ?? ""}\n${probe?.stderr ?? ""}`;
          if (probe?.code !== 0 || !/--thread\b/.test(usage) || !/--message\b/.test(usage))
            throw wakeError("The selected Codex executable does not expose queue --thread --message");
          queueCapabilities.add(key);
        }
        let result;
        try { result = await run(executable, ["queue", "--thread", threadId, "--message", prompt], { ...options, input: "" }); }
        catch (error) { throw classify(error); }
        if (result?.code !== 0) {
          const output = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
          const refused = /unknown subcommand|unrecognized subcommand|unexpected argument|invalid value|thread not found|session not found|no thread|no session|ambiguous session/i.test(output);
          throw wakeError(`Codex queue failed (${result?.code ?? result?.signal ?? "unknown"}): ${output.trim().slice(0, 2000)}`, refused ? "notSent" : "uncertain");
        }
        return { delivered: true, via: "codex-queue", supervisorThreadId: threadId };
      }
      if (mode !== "desktop") throw wakeError("Codex supervisor mode must be desktop or queue");
      try {
        const invoke = callApp ?? (await import("../desktop/codex-client.mjs")).callApp;
        await invoke("send_message_to_thread", { threadId, hostId: "local", prompt }, { signal });
        return { delivered: true, via: "codex-desktop", supervisorThreadId: threadId };
      } catch (error) { throw classify(error); }
    }
    const sessionId = identifier(supervisor.sessionId, "supervisor.sessionId");
    const mode = supervisor.mode ?? "channel";
    if (mode === "channel") {
      if (subscription.policy?.noFast && supervisor.fastDisabled !== true) throw wakeError("Live Claude supervisor does not have verified Fast-mode disablement");
      if (!sendChannel) throw wakeError("No Claude channel receiver is connected. Enable the channel or configure an unattended resume supervisor.");
      try {
        const result = await sendChannel(sessionId, event, prompt, { signal });
        if (result === false) throw wakeError("No Claude channel receiver accepted this event");
        if (result !== true && result?.delivered !== true && result?.accepted !== true)
          throw wakeError("Claude channel did not confirm event receipt", "uncertain");
        return { delivered: true, via: "claude-channel", sessionId };
      } catch (error) { throw classify(error); }
    }
    if (mode !== "resume") throw wakeError("Claude supervisor mode must be channel or resume");
    if (!supervisor.cwd || !path.isAbsolute(supervisor.cwd)) throw wakeError("Claude unattended resume requires an absolute supervisor.cwd");
    if (!fs.statSync(supervisor.cwd, { throwIfNoEntry: false })?.isDirectory()) throw wakeError("Claude supervisor.cwd is not an existing directory");
    const executable = supervisor.executable ?? "claude";
    if (typeof executable !== "string" || !executable.trim() || /[\r\n\0]/.test(executable)) throw wakeError("Invalid Claude executable");
    const release = sessionLease(path.resolve(home), sessionId);
    const configDir = path.join(path.resolve(home), "wake-configs");
    let configFile;
    try {
      fs.mkdirSync(configDir, { recursive: true });
      configFile = path.join(configDir, `${crypto.randomUUID()}.json`);
      const eventEnv = { CODEX_RELAY_HOME: path.resolve(home), CODEX_HOME: codexHome,
        CODEX_RELAY_WAKE_EVENT_ID: event.id, CODEX_RELAY_WAKE_SUBSCRIPTION_ID: event.subscriptionId ?? subscription.id,
        CODEX_RELAY_WAKE_THREAD_ID: subscription.threadId };
      fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { codex_relay: { type: "stdio", command: runtime, args: [mcpPath], env: eventEnv } } }), { flag: "wx", mode: 0o600 });
      const args = ["--resume", sessionId, "--print", "--input-format", "text", "--output-format", "json", "--mcp-config", configFile,
        "--strict-mcp-config", "--settings", '{"fastMode":false}', "--tools", "",
        "--allowedTools", ...followupTools.map((name) => `mcp__codex_relay__${name}`)];
      const env = { ...process.env, ...eventEnv, CLAUDE_CODE_DISABLE_FAST_MODE: "1" };
      // This is an explicitly selected, separate host process, not a nested interactive session.
      delete env.CLAUDECODE;
      const result = await run(executable, args, { input: prompt, cwd: supervisor.cwd, env, timeoutMs: 10 * 60_000, signal, label: "Claude resume" });
      const output = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
      if (result?.code !== 0) {
        // Claude documents this noninteractive rejection as having sent nothing to the running session.
        const refused = /session is running in the background|session is already running|your prompt was not sent|no conversation found|no session found|authentication required|not logged in/i.test(output);
        throw wakeError(`Claude resume failed (${result?.code ?? result?.signal ?? "unknown"}): ${output.trim().slice(0, 2000)}`, refused ? "notSent" : "uncertain");
      }
      let response;
      try { response = JSON.parse(result.stdout.trim()); }
      catch { throw wakeError("Claude resume returned invalid JSON; inspect delivery before retrying", "uncertain"); }
      if (response?.type !== "result" || typeof response.is_error !== "boolean")
        throw wakeError("Claude resume did not return a result envelope; inspect delivery before retrying", "uncertain");
      if (response.is_error === true) throw wakeError(`Claude processed the event but reported an error: ${String(response.result ?? response.subtype ?? "unknown").slice(0, 1000)}`, "uncertain");
      return { delivered: true, via: "claude-resume", sessionId: response.session_id ?? sessionId };
    } catch (error) { throw classify(error); }
    finally {
      try {
        if (configFile) { try { fs.unlinkSync(configFile); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      } finally { release(); }
    }
  };
}

export const wakeHost = createWakeHost();
