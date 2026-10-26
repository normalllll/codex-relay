// Shared Codex Relay client: talks to the relay control pipe, picks a loaded caller thread,
// and builds the compact status views used by claude-mcp.mjs and codex-wait.mjs.
import { openReadOnlyDatabase } from "../runtime/sqlite.mjs";
import { relayHome, codexHome } from "../runtime/paths.mjs";
import { relay } from "./transport.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { discoverProject } from "../tasks/project-discovery.mjs";

const ANSWERED_FILE = path.join(relayHome, "answered-calls.json");
const MAX_CALLER_ATTEMPTS = 8;
const MESSAGE_CHARS = 600;
const QUESTION_POLL_MS = 20_000;
// The desktop API caps recent entries separately from the complete pinned list.
export const MAX_RECENT_THREADS = 50;

// ---- Caller thread selection ----
let callers = [];

export function discoverStateDatabase() {
  if (process.env.CODEX_RELAY_STATE_DB) return path.resolve(process.env.CODEX_RELAY_STATE_DB);
  try {
    return fs.readdirSync(codexHome).filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))
      .map((name) => path.join(codexHome, name))[0] ?? null;
  } catch { return null; }
}

export function recentThreadIds() {
  let db;
  try {
    const file = discoverStateDatabase();
    if (!file) return [];
    db = openReadOnlyDatabase(file);
    const columns = db.prepare("pragma table_info(threads)").all().map((row) => row.name);
    const updated = columns.includes("updated_at_ms") ? "updated_at_ms" : "updated_at";
    const rows = db
      .prepare(`select id from threads where archived = 0 order by ${updated} desc limit 20`)
      .all();
    return rows.map((row) => row.id);
  } catch {
    return [];
  } finally { db?.close(); }
}

// Waiting or sending cannot use the target as caller. Read-only inspection may read itself.
function candidateCallers(targetIds) {
  return [...new Set([process.env.CODEX_THREAD_ID, ...callers, ...recentThreadIds()].filter(Boolean))]
    .filter((id) => !targetIds.includes(id))
    .slice(0, MAX_CALLER_ATTEMPTS);
}

async function refreshCallers(workingCaller, options) {
  try {
    const listed = await callTool("list_threads", { limit: 20 }, workingCaller, options);
    const loaded = [...(listed.pinnedThreads ?? []), ...(listed.threads ?? [])]
      .filter((thread) => thread.kind === "codex" && thread.status !== "notLoaded")
      .map((thread) => thread.id);
    callers = [...new Set([workingCaller, ...loaded])];
  } catch {
    callers = [workingCaller];
  }
}

async function callTool(tool, args, caller, options) {
  const result = await relay("tools/call", { tool, threadId: caller, namespace: "codex_app", arguments: args }, options);
  const text = (result.contentItems ?? []).map((item) => item.text ?? "").join("\n");
  if (!result.success) throw new Error(text || `${tool} failed`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A rejected caller fails inside the app before the tool runs, so trying the next one is safe.
export async function callApp(tool, args, options) {
  let lastError;
  const targetIds = [args.threadId, ...(args.targets ?? []).map((target) => target.threadId)].filter(Boolean);
  for (const caller of candidateCallers(tool === "read_thread" ? [] : targetIds)) {
    try {
      const result = await callTool(tool, args, caller, options);
      if (callers[0] !== caller) await refreshCallers(caller, options);
      return result;
    } catch (error) {
      lastError = error;
      // The app rejects a caller that is unloaded (a generic pipe failure, or "thread not loaded:
      // <id other than the target>"), or that is related to the target (a descendant cannot send
      // to its "native ancestor"; a thread cannot wait on "the calling thread").
      const notLoaded = /thread not loaded: (\S+)/.exec(error.message)?.[1];
      const callerRejected =
        (notLoaded != null && !targetIds.includes(notLoaded)) ||
        /native ancestor|calling thread/i.test(error.message);
      if (!callerRejected) throw error;
      callers = callers.filter((id) => id !== caller);
    }
  }
  throw new Error(
    `No loaded Codex thread could act as caller (${lastError?.message ?? "no candidates"}). ` +
      "Open the Codex app and send any message in one of its threads, then retry.",
  );
}

// ---- Compact views ----
export const clip = (text, limit = MESSAGE_CHARS) =>
  text && text.length > limit ? `${text.slice(0, limit)}…` : (text ?? null);

export async function resolveProject(args) {
  return (await resolveProjectDetails(args)).projectId;
}

export async function resolveProjectDetails(args) {
  if (args.projectId && args.projectPath) throw new Error("Pass projectPath or projectId, not both");
  return discoverProject(args, { callApp, threadLimit: MAX_RECENT_THREADS });
}

// ---- Question bookkeeping ----
// A question is identified like the app does: ["request_user_input_async", <callId>, <index>].
const questionItemId = (callId, index) => JSON.stringify(["request_user_input_async", callId, index]);
const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";

// Question ids answered through codex-ipc, shared with the background wait process so a reply that
// has not yet shown up in the thread is not reported again.
function locallyAnswered() {
  let prior = [];
  try {
    prior = JSON.parse(fs.readFileSync(ANSWERED_FILE, "utf8"));
  } catch {}
  const result = new Set(Array.isArray(prior) ? prior : []);
  try {
    for (const file of fs.readdirSync(path.join(relayHome, "answered"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try { result.add(JSON.parse(fs.readFileSync(path.join(relayHome, "answered", file), "utf8"))); } catch {}
    }
  } catch {}
  return result;
}

export function markAnswered(questionItemIds) {
  const dir = path.join(relayHome, "answered");
  fs.mkdirSync(dir, { recursive: true });
  for (const id of questionItemIds) {
    const file = path.join(dir, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
    try { fs.writeFileSync(file, JSON.stringify(id), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
}

// Question ids a user message answers, using the app's rule: exactly one text part holding a
// structured question reply.
function answeredBy(item) {
  const parts = item.content ?? item.input;
  if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0]?.text !== "string") return [];
  const text = parts[0].text.trim();
  if (!text.startsWith(REPLY_OPEN) || !text.endsWith(REPLY_CLOSE)) return [];
  try {
    const replies = JSON.parse(text.slice(REPLY_OPEN.length, -REPLY_CLOSE.length));
    return (Array.isArray(replies) ? replies : [replies]).map((reply) => reply.questionItemId);
  } catch {
    return [];
  }
}

// ---- Bounded session-log reading ----
// Session logs can reach gigabytes. They are only ever read from the end in fixed chunks, newest
// line first, up to a hard limit, and only compact fields leave this module.
const SESSIONS_DIR = path.join(codexHome, "sessions");
const ROLLOUT_CHUNK_BYTES = 1024 * 1024;
const ROLLOUT_SCAN_LIMIT = 64 * 1024 * 1024;
const ROLLOUT_APPEND_LIMIT = 4 * 1024 * 1024;
const rolloutPaths = new Map();

// Calls visit(line) for complete lines from the end of the file until it returns true or the limit
// is reached. Returns whether the scan reached the stopping line or the start of the file.
export function scanRolloutBackward(file, visit, limit = ROLLOUT_SCAN_LIMIT) {
  const fd = fs.openSync(file, "r");
  try {
    let position = fs.fstatSync(fd).size;
    const floor = Math.max(0, position - limit);
    let carry = Buffer.alloc(0);
    while (position > floor) {
      const start = Math.max(floor, position - ROLLOUT_CHUNK_BYTES);
      const chunk = Buffer.alloc(position - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      position = start;
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let end = data.length;
      while (end > 0) {
        const newline = data.lastIndexOf(10, end - 1);
        if (newline < 0) break;
        const line = data.subarray(newline + 1, end);
        end = newline;
        if (line.length && visit(line.toString("utf8"))) return true;
      }
      carry = data.subarray(0, end);
    }
    // The first line has no newline before it; a cut-off line at the limit is discarded.
    if (position === 0) return (carry.length > 0 && visit(carry.toString("utf8"))) || true;
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// The current (latest) turn, reconstructed from the end of the session log. Lines are checked by
// substring before parsing, and the scan stops at the turn's start.
function rolloutTurn(threadId) {
  const file = findRollout(threadId);
  if (!file) return null;
  const turn = { turnId: null, status: null, cwd: null, message: null, asked: [], answered: new Set() };
  const complete = scanRolloutBackward(file, (line) => {
    const context = line.includes('"type":"turn_context"');
    if (!context && !line.includes('"type":"event_msg"')) return false;
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    const payload = entry.payload ?? {};
    if (context) {
      if (!turn.turnId || payload.turn_id === turn.turnId) turn.cwd ??= payload.cwd ?? null;
      return false;
    }
    if (payload.turn_id && turn.turnId && payload.turn_id !== turn.turnId) return true;
    if (payload.type === "task_complete" || payload.type === "turn_aborted") {
      if (turn.turnId) return false;
      turn.turnId = payload.turn_id ?? null;
      turn.status = payload.type === "task_complete" ? "completed" : "interrupted";
      if (!payload.last_agent_message) return false;
      // An ended turn has no pending questions: its final message is all a status needs.
      turn.message = { id: null, text: payload.last_agent_message, phase: "final_answer" };
      return true;
    }
    if (payload.type === "task_started") {
      turn.turnId ??= payload.turn_id ?? null;
      return true;
    }
    if (payload.type !== "item_completed") return false;
    turn.turnId ??= payload.turn_id ?? null;
    const item = payload.item;
    if (item?.type === "AgentMessage") {
      const text = (item.content ?? []).map((part) => part.text ?? "").join("");
      turn.message ??= { id: item.id, text, phase: item.phase ?? null };
      if (String(item.id).startsWith("call_")) turn.asked.unshift({ callId: item.id, text });
    } else if (item?.type === "UserMessage") {
      for (const id of answeredBy(item)) turn.answered.add(id);
    }
    return false;
  });
  if (!turn.turnId) return null;
  turn.status ??= "inProgress";
  turn.partial = !complete;
  return turn;
}

// ---- Question lists from the session log ----

function findRollout(threadId) {
  if (rolloutPaths.has(threadId)) return rolloutPaths.get(threadId);
  const suffix = `-${threadId}.jsonl`;
  // sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl; newest days first.
  const newestFirst = (dir) => fs.readdirSync(dir).sort().reverse();
  try {
    for (const year of newestFirst(SESSIONS_DIR))
      for (const month of newestFirst(path.join(SESSIONS_DIR, year)))
        for (const day of newestFirst(path.join(SESSIONS_DIR, year, month))) {
          const dir = path.join(SESSIONS_DIR, year, month, day);
          const file = fs.readdirSync(dir).find((name) => name.endsWith(suffix));
          if (file) {
            rolloutPaths.set(threadId, path.join(dir, file));
            return rolloutPaths.get(threadId);
          }
        }
  } catch {}
  return null;
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// The app's thread view merges a multi-question call into one message, but the session log keeps
// the call's real `questions` array. Pending calls are in the current turn, so only the end of the
// (possibly huge) log is read.
export function questionsFromRollout(threadId, callId) {
  const file = findRollout(threadId);
  if (!file) return null;
  const marker = `"call_id":"${callId}"`;
  let line;
  scanRolloutBackward(file, (entry) => {
    if (!entry.includes(marker) || !entry.includes('"type":"function_call"')) return false;
    line = entry;
    return true;
  });
  if (!line) return null;
  try {
    const questions = JSON.parse(JSON.parse(line).payload.arguments).questions;
    return Array.isArray(questions) && questions.length ? questions.map((question) => question.title) : null;
  } catch {
    return null;
  }
}

// Every unanswered question in the latest turn, across all of Codex's question calls:
// { cwd, questions: [{ callId, index, questionItemId, question }] }, or null when there are none.
// A compact read of the latest turn: no tool outputs, one turn only.
const readLatestTurn = (threadId, options) => callApp("read_thread", {
  threadId,
  hostId: "local",
  turnLimit: 1,
  includeOutputs: false,
  maxOutputCharsPerItem: 0,
}, options);
const TOO_LARGE = /exceeds the size limit/i;

export async function pendingQuestions(threadId, options, read) {
  let thread = read;
  if (!thread) {
    try {
      thread = await readLatestTurn(threadId, options);
    } catch (error) {
      // A very long turn can exceed what read_thread returns; read the session log instead.
      if (TOO_LARGE.test(error.message)) return pendingFromRollout(threadId);
      throw error;
    }
  }
  const turn = thread.turns?.[0];
  if (!turn || turn.status !== "inProgress") return null;
  const answered = locallyAnswered();
  const asked = [];
  for (const item of turn.items ?? []) {
    if (item.type === "agentMessage" && String(item.id).startsWith("call_")) {
      const titles = questionsFromRollout(threadId, item.id) ?? [item.text];
      titles.forEach((question, index) =>
        asked.push({ callId: item.id, index, questionItemId: questionItemId(item.id, index), question }),
      );
    } else if (item.type === "userMessage" || item.type === "steeringUserMessage") {
      for (const id of answeredBy(item)) answered.add(id);
    }
  }
  const questions = asked.filter((entry) => !answered.has(entry.questionItemId));
  return questions.length ? { cwd: thread.thread?.cwd, questions } : null;
}

// The same view as pendingQuestions, built from the end of the session log for a turn too large
// for read_thread. Only completed items of the current turn count; compaction copies are skipped.
function pendingFromRollout(threadId, turn = rolloutTurn(threadId)) {
  if (turn?.status !== "inProgress") return null;
  const answered = locallyAnswered();
  for (const id of turn.answered) answered.add(id);
  const asked = turn.asked.flatMap(({ callId, text }) =>
    (questionsFromRollout(threadId, callId) ?? [text]).map((question, index) =>
      ({ callId, index, questionItemId: questionItemId(callId, index), question })));
  const questions = asked.filter((entry) => !answered.has(entry.questionItemId));
  return questions.length ? { cwd: turn.cwd, questions } : null;
}

// The structured reply the app recognizes as answering the given questions.
export function questionReply(pairs) {
  const replies = pairs.map(({ entry, answer }) => ({
    questionItemId: entry.questionItemId,
    question: entry.question,
    answer,
  }));
  return `${REPLY_OPEN}\n${JSON.stringify(replies)}\n${REPLY_CLOSE}`;
}

// ---- Status views ----
const FINAL_MESSAGE_CHARS = 4_000;

function snapshot(poll, messageChars) {
  const flags = poll.thread?.status?.activeFlags ?? [];
  const message = poll.latestAssistantMessage;
  return {
    threadId: poll.thread?.id,
    turnId: poll.latestTurn?.id ?? poll.latestAssistantMessage?.turnId ?? null,
    threadStatus: poll.thread?.status?.type ?? null,
    flags: flags.length ? flags : undefined,
    turnStatus: poll.latestTurn?.status ?? null,
    turnError: poll.latestTurn?.error ?? undefined,
    latestMessage: message
      ? {
          // Question calls are reported by the app as "final_answer"; label them for what they are.
          phase: String(message.id).startsWith("call_") ? "question" : message.phase,
          text: clip(message.text, messageChars),
        }
      : null,
    activity: poll.latestToolMarker ? poll.latestToolMarker.name ?? poll.latestToolMarker.type : null,
    cursor: poll.cursor,
  };
}

// What the thread is waiting on when the app flags it (for example a command awaiting approval).
async function attentionDetails(threadId, options, read) {
  try {
    const thread = read ?? await readLatestTurn(threadId, options);
    const items = thread.turns?.[0]?.items ?? [];
    const open = items.findLast(
      (item) =>
        ["commandExecution", "fileChange", "mcpToolCall"].includes(item.type) &&
        !["completed", "failed", "declined"].includes(item.status),
    );
    if (!open) return undefined;
    return {
      type: open.type,
      command: clip(open.command, 300) ?? undefined,
      files: open.changes?.map((change) => change.path),
      tool: open.tool ? `${open.server ?? ""}/${open.tool}` : undefined,
    };
  } catch {
    return undefined;
  }
}

// Some desktop versions fail every externally relayed wait_threads call ("The app tool call ended
// before producing a result") while read_thread keeps working. After such a failure, status is
// built from read_thread for a while instead of failing; wait_threads is retried later.
const APP_TOOL_FAILURE = /Codex app tool request failed|ended before producing a result/i;
const WAIT_THREADS_RETRY_MS = 10 * 60_000;
let waitThreadsFailedAt = -Infinity;
const waitThreadsUsable = () => Date.now() - waitThreadsFailedAt >= WAIT_THREADS_RETRY_MS;
function noteWaitThreadsFailure(error) {
  if (!APP_TOOL_FAILURE.test(error.message)) throw error;
  waitThreadsFailedAt = Date.now();
}

const UNAVAILABLE = /not found|no such thread|unknown thread|archived/i;

function readView(threadId, thread, messageChars) {
  const turn = thread.turns?.[0];
  const items = turn?.items ?? [];
  const flags = thread.thread?.status?.activeFlags ?? [];
  const message = items.findLast((item) => item.type === "agentMessage");
  const activity = items.findLast((item) => !["agentMessage", "userMessage", "steeringUserMessage", "reasoning"].includes(item.type));
  return {
    threadId: thread.thread?.id ?? threadId,
    turnId: turn?.id ?? null,
    threadStatus: thread.thread?.status?.type ?? null,
    flags: flags.length ? flags : undefined,
    turnStatus: turn?.status ?? null,
    turnError: turn?.error ?? undefined,
    latestMessage: message
      ? { phase: String(message.id).startsWith("call_") ? "question" : message.phase ?? null, text: clip(message.text, messageChars) }
      : null,
    activity: activity ? activity.tool ?? activity.name ?? activity.type : null,
    source: "read_thread",
  };
}

export function rolloutView(threadId) {
  const turn = rolloutTurn(threadId);
  if (!turn) return { threadId, threadStatus: "unavailable", error: "Thread too large for read_thread and no readable session log" };
  const ended = turn.status !== "inProgress";
  const view = {
    threadId, turnId: turn.turnId, threadStatus: null, turnStatus: turn.status,
    latestMessage: turn.message
      ? { phase: String(turn.message.id).startsWith("call_") ? "question" : turn.message.phase, text: clip(turn.message.text, ended ? FINAL_MESSAGE_CHARS : MESSAGE_CHARS) }
      : null,
    activity: null, source: "rollout", ...(turn.partial ? { partial: true } : {}),
  };
  const pending = pendingFromRollout(threadId, turn);
  if (pending) view.questions = compactQuestions(pending.questions);
  return view;
}

const compactQuestions = (questions) => questions.map(({ callId, index, question }) => ({ callId, index, question: clip(question, 2000) }));

export async function statusFromRead(threadId, options) {
  let thread;
  try {
    thread = await readLatestTurn(threadId, options);
  } catch (error) {
    if (TOO_LARGE.test(error.message)) return rolloutView(threadId);
    if (UNAVAILABLE.test(error.message)) return { threadId, threadStatus: "unavailable", error: error.message };
    throw error;
  }
  const ended = thread.turns?.[0]?.status !== "inProgress";
  const view = readView(threadId, thread, ended ? FINAL_MESSAGE_CHARS : MESSAGE_CHARS);
  if (!ended) {
    const pending = await pendingQuestions(threadId, options, thread);
    if (pending) view.questions = compactQuestions(pending.questions);
    if (view.flags?.length) view.attention = await attentionDetails(threadId, options, thread);
  }
  return view;
}

export async function status(threadId, options) {
  if (!waitThreadsUsable()) return statusFromRead(threadId, options);
  let result;
  try {
    result = await callApp("wait_threads", { targets: [{ threadId, hostId: "local" }], timeoutMs: 0 }, options);
  } catch (error) {
    noteWaitThreadsFailure(error);
    return statusFromRead(threadId, options);
  }
  // Archived or otherwise unresolvable threads come back as per-target errors with no poll.
  if (!result.polls?.length)
    return { threadId, threadStatus: "unavailable", error: result.errors?.[0]?.message ?? "thread unavailable" };
  const poll = result.polls[0];
  const ended = poll.latestTurn?.status !== "inProgress";
  const view = snapshot(poll, ended ? FINAL_MESSAGE_CHARS : MESSAGE_CHARS);
  if (!ended) {
    const pending = await pendingQuestions(threadId, options);
    if (pending) view.questions = compactQuestions(pending.questions);
    if (view.flags?.length) view.attention = await attentionDetails(threadId, options);
  }
  return view;
}

// Session-log entries that can change what a wait reports: a question, a turn end, or a request
// that may need the user's attention.
const ROLLOUT_WAKE_MARKERS = ['"name":"request_user_input_async"', '"type":"task_complete"', '"type":"turn_aborted"', "_approval_request"];

// Resolves when the thread's session log gains an entry that may change the wait result, so it is
// noticed at once instead of at the next periodic check. Only newly appended bytes are read, at
// most ROLLOUT_APPEND_LIMIT per change; anything skipped is caught by the periodic status check.
function rolloutActivity(threadId) {
  const file = findRollout(threadId);
  if (!file) return { promise: new Promise(() => {}), cancel: () => {} };
  let offset = fs.statSync(file).size;
  let overlap = "";
  let watcher;
  const promise = new Promise((resolve) => {
    try {
      watcher = fs.watch(file, () => {
        try {
          const size = fs.statSync(file).size;
          if (size <= offset) return;
          const start = Math.max(offset, size - ROLLOUT_APPEND_LIMIT);
          const appended = (start === offset ? overlap : "") + readRange(file, start, size);
          offset = size;
          overlap = appended.slice(-64);
          if (ROLLOUT_WAKE_MARKERS.some((marker) => appended.includes(marker))) resolve();
        } catch {}
      });
    } catch {}
  });
  return { promise, cancel: () => watcher?.close() };
}

const delay = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

// Blocks inside this process (no model tokens) until the turn ends, Codex asks a question,
// the thread needs attention (for example an approval), or the overall timeout passes.
// With pastAttention, flags already present when the wait starts were reported before (an
// approval only the user can give in Codex): they do not end the wait, so it lasts until the user
// acts and the flags change, or until a turn end, a question, or the timeout.
export async function wait(threadId, timeoutMinutes, { pastAttention = false } = {}) {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 0 || timeoutMinutes > 60)
    throw new Error("timeoutMinutes must be between 0 and 60");
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const flagsKey = (view) => (view.flags ?? []).slice().sort().join(",");
  let reported;
  let cursor;
  while (true) {
    const view = await status(threadId);
    if (view.threadStatus === "unavailable") return { ...view, reason: "unavailable" };
    if (view.turnStatus !== "inProgress") return { ...view, reason: "turnEnded" };
    if (view.questions) return { ...view, reason: "question" };
    reported ??= pastAttention ? flagsKey(view) : "";
    if (view.flags?.length && flagsKey(view) !== reported) return { ...view, reason: "needsAttention" };
    // Once the old flags clear, any later flag is new.
    if (!view.flags?.length) reported = "";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...view, reason: "timeout" };
    cursor = view.cursor ?? cursor;
    // wait_threads does not wake on questions: also watch the session log, and re-check every
    // 20 s as a fallback. Without a working wait_threads, the log and the 20 s check carry the wait.
    const activity = rolloutActivity(threadId);
    const controller = new AbortController();
    const interval = Math.min(remaining, QUESTION_POLL_MS);
    try {
      await Promise.race([
        waitThreadsUsable()
          ? callApp("wait_threads", {
            targets: [{ threadId, hostId: "local", ...(cursor ? { afterCursor: cursor } : {}) }],
            timeoutMs: interval,
          }, { signal: controller.signal }).catch(noteWaitThreadsFailure)
          : delay(interval, controller.signal),
        activity.promise,
      ]);
    } finally { activity.cancel(); controller.abort(); }
  }
}
