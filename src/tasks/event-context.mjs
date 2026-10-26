import crypto from "node:crypto";
import { WatchStore } from "../watch/watch-store.mjs";
import { status } from "../desktop/codex-client.mjs";
import { readTaskReport } from "./task-report.mjs";

const shorten = (value, limit) => {
  if (typeof value !== "string" || value.length <= limit) return value;
  let end = limit;
  if (/[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
  return value.slice(0, end);
};
const bounded = (value, limit) => typeof value === "string" ? shorten(value, limit) : value;
const integer = (value, fallback, minimum, maximum, name) => {
  value ??= fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  return value;
};
function summary(state, previewChars) {
  if (!state) return null;
  const result = {};
  for (const field of ["threadId", "turnId", "threadStatus", "turnStatus", "activity", "source", "partial"])
    if (state[field] !== undefined) result[field] = bounded(state[field], 300);
  if (state.error) result.error = bounded(state.error, 600);
  if (state.turnError) result.turnError = bounded(typeof state.turnError === "string" ? state.turnError : JSON.stringify(state.turnError), 600);
  if (state.flags?.length) result.flags = state.flags.slice(0, 16).map((flag) => bounded(flag, 100));
  if (state.latestMessage) {
    const text = state.latestMessage.text ?? "";
    result.latestMessage = { phase: state.latestMessage.phase, text: shorten(text, previewChars), truncated: text.length > previewChars };
  }
  if (state.questions?.length) {
    result.questions = state.questions.slice(0, 16).map(({ callId, index, question }) => ({ callId, index, question: bounded(question, 800), truncated: typeof question === "string" && question.length > 800 }));
    if (state.questions.length > 16) result.questionsTruncated = true;
  }
  if (state.attention) {
    result.attention = { type: state.attention.type, command: bounded(state.attention.command, 300), tool: bounded(state.attention.tool, 150), files: state.attention.files?.slice(0, 16).map((file) => bounded(file, 200)) };
  }
  return result;
}

export function createEventReader({ store = new WatchStore(), readStatus = status, readReport = readTaskReport } = {}) {
  async function context({ eventId, previewChars }) {
    previewChars = integer(previewChars, 400, 64, 2000, "previewChars");
    const { event, subscription } = store.eventContext(eventId);
    const metadata = { eventId: event.id, subscriptionId: event.subscriptionId, threadId: event.threadId, type: event.type, turnId: event.turnId, phase: event.phase };
    if (event.phase === "acknowledged") return { event: metadata, handled: true, action: event.action, nextAction: "skip" };
    const result = { event: metadata, handled: false, dataTrust: "taskData", subscriptionEnabled: subscription?.enabled ?? false,
      report: { tool: "codex_event_report", eventId }, nextAction: event.phase === "uncertain" ? "reconcile" : "handle" };
    if (subscription?.target) result.target = subscription.target;
    if (!result.subscriptionEnabled) return { ...result, nextAction: "skip" };
    if (subscription?.goal) {
      result.goal = { task: bounded(subscription.goal.task, 1000), doneWhen: bounded(subscription.goal.doneWhen, 2000) };
      if (result.goal.task !== subscription.goal.task || result.goal.doneWhen !== subscription.goal.doneWhen) {
        result.goalTruncated = true; result.goalReport = { tool: "codex_event_report", eventId, section: "goal" };
      }
    }
    if (subscription?.policy) result.policy = subscription.policy;
    try {
      const current = await readStatus(event.threadId);
      result.current = summary(current, previewChars);
      result.currentAvailable = Boolean(current && current.threadStatus !== "unavailable");
      result.stale = Boolean(event.turnId && current?.turnId && event.turnId !== current.turnId);
      if (result.stale || !result.currentAvailable) result.eventPreview = summary(event.payload ?? event.snapshot, previewChars);
      if (!result.currentAvailable) result.nextAction = "retryStatus";
    } catch (error) {
      result.currentAvailable = false; result.current = { error: bounded(error.message, 600) };
      result.eventPreview = summary(event.payload ?? event.snapshot, previewChars); result.nextAction = "retryStatus";
    }
    // The event may have been handled while a slow status request was in flight.
    const latestContext = store.eventContext(eventId);
    const latest = latestContext.event;
    if (latest.phase === "acknowledged") return { event: { ...metadata, phase: latest.phase }, handled: true, action: latest.action, nextAction: "skip" };
    result.event.phase = latest.phase;
    result.subscriptionEnabled = latestContext.subscription?.enabled ?? false;
    if (!result.subscriptionEnabled) result.nextAction = "skip";
    else if (latest.phase === "uncertain" && result.currentAvailable) result.nextAction = "reconcile";
    return result;
  }

  async function report({ eventId, section = "report", offset, limit, reportHash }) {
    offset = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    limit = integer(limit, 4000, 256, 16000, "limit");
    if (!["report", "goal", "snapshot"].includes(section)) throw new Error("section must be report, goal, or snapshot");
    const { event, subscription } = store.eventContext(eventId);
    let record;
    if (section === "goal") record = { text: JSON.stringify(subscription?.goal ?? null), source: "subscription", complete: true };
    else if (section === "snapshot") record = { text: JSON.stringify(event.payload ?? event.snapshot ?? null), source: "eventSnapshot", complete: true };
    else record = await readReport({ threadId: event.threadId, turnId: event.turnId, snapshot: event.payload ?? event.snapshot });
    if (!record || typeof record.text !== "string") throw new Error("Report reader returned invalid text");
    const text = record.text;
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (reportHash && reportHash !== hash) throw new Error("Report changed since the previous page; restart pagination");
    if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "") && /[\uD800-\uDBFF]/.test(text[offset - 1]))) throw new Error("offset is outside the report or splits a Unicode character");
    const chunk = shorten(text.slice(offset), limit);
    const next = offset + chunk.length;
    return { eventId: event.id, threadId: event.threadId, turnId: event.turnId, section, source: record.source, complete: record.complete,
      ...(record.reason ? { reason: record.reason } : {}), text: chunk, offset, totalChars: text.length, reportHash: hash, nextOffset: next < text.length ? next : null };
  }
  return { context, report };
}
