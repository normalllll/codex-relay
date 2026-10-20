import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { callApp, scanRolloutBackward } from "./codex-client.mjs";
import { openReadOnlyDatabase } from "./sqlite.mjs";

const SCAN_LIMIT = 64 * 1024 * 1024;
const validThread = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,300}$/.test(value);
const validTurn = (value) => typeof value === "string" && value.length > 0 && value.length <= 300 && !/[\r\n\0]/.test(value);
const messageText = (item) => {
  if (typeof item?.text === "string") return item.text;
  if (!Array.isArray(item?.content)) return null;
  return item.content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
};
const query = (database, sql, read) => {
  const statement = database.prepare(sql);
  try { return read(statement); }
  finally { statement.finalize?.(); }
};

function rolloutPath(codexDirectory, threadId) {
  let database;
  try {
    const names = fs.readdirSync(codexDirectory).filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (names.length) {
      database = openReadOnlyDatabase(path.join(codexDirectory, names[0]));
      const columns = query(database, "pragma table_info(threads)", (statement) => statement.all()).map((row) => row.name);
      if (columns.includes("rollout_path")) {
        const row = query(database, "select rollout_path from threads where id = ?", (statement) => statement.get(threadId));
        if (typeof row?.rollout_path === "string" && path.isAbsolute(row.rollout_path)) return row.rollout_path;
      }
    }
  } catch {} finally { database?.close(); }
  const sessions = path.join(codexDirectory, "sessions");
  const suffix = `-${threadId}.jsonl`;
  try {
    for (const year of fs.readdirSync(sessions).filter((name) => /^\d{4}$/.test(name)).sort().reverse())
      for (const month of fs.readdirSync(path.join(sessions, year)).filter((name) => /^\d{2}$/.test(name)).sort().reverse())
        for (const day of fs.readdirSync(path.join(sessions, year, month)).filter((name) => /^\d{2}$/.test(name)).sort().reverse()) {
          const directory = path.join(sessions, year, month, day);
          const file = fs.readdirSync(directory).find((name) => name.endsWith(suffix));
          if (file) return path.join(directory, file);
        }
  } catch {}
  return null;
}

function reportFromRollout(codexDirectory, threadId, turnId) {
  const file = rolloutPath(codexDirectory, threadId);
  if (!file) return null;
  let finalText = null, itemText = null;
  try {
    scanRolloutBackward(file, (line) => {
      if (!line.includes(turnId)) return false;
      let entry;
      try { entry = JSON.parse(line); } catch { return false; }
      if (entry.type !== "event_msg") return false;
      const payload = entry.payload;
      if (payload?.turn_id !== turnId || (payload.thread_id && payload.thread_id !== threadId)) return false;
      if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
        finalText = payload.last_agent_message;
        return true;
      }
      if (payload.type === "item_completed" && ["AgentMessage", "agentMessage"].includes(payload.item?.type))
        itemText ??= messageText(payload.item);
      return payload.type === "task_started";
    }, SCAN_LIMIT);
  } catch { return null; }
  const text = finalText ?? itemText;
  return text === null ? null : { text, source: "rollout", complete: true };
}

const readDesktopThread = (threadId) => callApp("read_thread", {
  threadId, hostId: "local", turnLimit: 20, includeOutputs: false, maxOutputCharsPerItem: 0,
});

/** Read the complete message from the recorded turn, never a replacement latest turn. */
export async function readTaskReport({ threadId, turnId, snapshot } = {}, {
  readThread = readDesktopThread,
  codexDirectory = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
} = {}) {
  if (validThread(threadId) && validTurn(turnId)) {
    try {
      const thread = await readThread(threadId);
      if (!thread?.thread?.id || thread.thread.id === threadId) {
        const turn = thread?.turns?.find((item) => item.id === turnId);
        const message = turn?.items?.findLast((item) => item.type === "agentMessage");
        const text = messageText(message);
        if (text !== null) return { text, source: "read_thread", complete: true };
      }
    } catch {}
    const rollout = reportFromRollout(path.resolve(codexDirectory), threadId, turnId);
    if (rollout) return rollout;
  }
  return {
    text: typeof snapshot?.latestMessage?.text === "string" ? snapshot.latestMessage.text : "",
    source: "captured", complete: false,
    reason: "The complete report for the recorded turn is unavailable; only the captured event excerpt is returned.",
  };
}
