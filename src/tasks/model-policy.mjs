import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openReadOnlyDatabase } from "../runtime/sqlite.mjs";
import { readSessionPolicy as desktopSessionPolicy } from "../desktop/codex-ipc.mjs";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_ROLLOUT_BYTES = 2 * 1024 * 1024;
const accelerated = new Set(["fast", "priority", "ultrafast"]);
const standard = new Set(["default", "standard"]);
const newThreadAction = "Configure an explicit service_tier = \"default\" for new threads, resolve any conflicting policy, then run preflight again. Relay does not rewrite global settings.";
const sessionAction = "Select Standard for this Codex session, then run preflight again with the same requestId. New-thread defaults cannot change an existing session's mode.";
const unavailableSessionAction = "The host has not exposed an explicit tier for this session. Keep setup blocked and preserve its requestId. Do not repeatedly toggle the tier, rewrite global defaults, or claim Standard was verified. Retry only when a supported session-policy reader or fresh metadata provides the missing evidence.";

function classify(value) {
  if (typeof value !== "string") return "unknown";
  const tier = value.toLowerCase();
  return accelerated.has(tier) ? "fast" : standard.has(tier) ? "standard" : "unknown";
}

function stripComment(line) {
  let quote = null, escaped = false;
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = null; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, i).trim();
  }
  return line.trim();
}

function tomlString(value) {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try { return JSON.parse(value); } catch {}
  }
  return undefined;
}

// This is deliberately a narrow policy reader, not a permissive TOML parser.
// Unrecognized policy syntax cannot establish that an inference will use Standard.
function configEvidence(file) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return { source: file, status: "unknown", reason: "Configuration exceeds the policy inspection limit" };
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { source: file, status: "unknown", reason: "Configuration could not be read" };
  }
  const findings = [];
  let table = "", ambiguous = /'''|"""/.test(text), tier;
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    if (line.startsWith("[")) {
      const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
      table = header?.[1] ?? "?";
      continue;
    }
    if (!/service_tier|fast_mode/.test(line)) continue;
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    const key = assignment?.[1];
    const fullKey = table ? `${table}.${key ?? "?"}` : key;
    if (!assignment || table === "?" || fullKey?.startsWith("profiles.") || key?.includes("profiles.")) { ambiguous = true; continue; }
    const policyKey = ["service_tier", "models.new_thread.service_tier"].includes(fullKey);
    const featureKey = fullKey === "features.fast_mode";
    if (!policyKey && !featureKey) {
      if (key?.includes("service_tier") || line.includes("{") || table.startsWith("models.")) ambiguous = true;
      continue;
    }
    if (seen.has(fullKey)) ambiguous = true;
    seen.add(fullKey);
    if (policyKey) {
      const value = tomlString(assignment[2]);
      const status = classify(value);
      findings.push(status);
      if (status === "unknown") ambiguous = true;
      tier = value ?? tier;
    } else if (!["true", "false"].includes(assignment[2])) ambiguous = true;
    // fast_mode only enables the capability; it does not select the service tier.
  }
  if (findings.includes("fast")) return { source: file, status: "fast", tier };
  if (ambiguous) return { source: file, status: "unknown", reason: "Policy syntax or profile overrides cannot be resolved conservatively" };
  if (findings.length) return { source: file, status: "standard", tier, kind: "configuration" };
  return { source: file, status: "unspecified", kind: "configuration" };
}

function configFiles(codexDirectory, projectPath) {
  const files = [path.join(codexDirectory, "config.toml"), path.join(codexDirectory, "requirements.toml")];
  if (projectPath && path.isAbsolute(projectPath)) {
    let directory = path.resolve(projectPath);
    for (;;) {
      files.push(path.join(directory, ".codex", "config.toml"));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...new Set(files)];
}

function tiersFromMetadata(value) {
  if (!value || typeof value !== "object") return [];
  const records = [value, value.thread, value.latestTurn, value.turns?.[0], value.turnContext, value.turn_context,
    value.turns?.[0]?.turnContext, value.turns?.[0]?.turn_context];
  return records.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    return [record.service_tier, record.serviceTier, record.config?.service_tier, record.config?.serviceTier]
      .filter((tier) => tier !== undefined && tier !== null);
  });
}

function rolloutPath(codexDirectory, threadId) {
  let db;
  try {
    const names = fs.readdirSync(codexDirectory).filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (names.length) {
      db = openReadOnlyDatabase(path.join(codexDirectory, names[0]));
      const columns = db.prepare("pragma table_info(threads)").all().map((row) => row.name);
      if (columns.includes("rollout_path")) {
        const row = db.prepare("select rollout_path from threads where id = ?").get(threadId);
        if (typeof row?.rollout_path === "string" && path.isAbsolute(row.rollout_path)) return row.rollout_path;
      }
    }
  } catch {} finally { db?.close(); }
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

function rolloutEvidence(codexDirectory, threadId) {
  const file = rolloutPath(codexDirectory, threadId);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_ROLLOUT_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_ROLLOUT_BYTES));
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, length).toString("utf8").split("\n");
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
      let entry;
      try { entry = JSON.parse(line); }
      catch {
        if (/"type"\s*:\s*"(?:turn_context|session_meta)"/.test(line))
          return { source: file, kind: "session", tiers: [], reason: "The latest policy context is incomplete or malformed" };
        continue;
      }
      if (!["turn_context", "session_meta"].includes(entry.type)) continue;
      const payload = entry.payload;
      if (payload?.thread_id && payload.thread_id !== threadId) continue;
      if (entry.type === "session_meta" && payload?.id && payload.id !== threadId) continue;
      // The latest context supersedes historical settings, even if its tier is omitted.
      return { source: file, kind: "session", tiers: tiersFromMetadata(payload) };
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

export async function inspectModelPolicy({ threadId, projectPath, codexDirectory = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), readThread, readSessionPolicy = desktopSessionPolicy } = {}) {
  if (threadId !== undefined && (typeof threadId !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(threadId)))
    return { ok: false, tier: "unknown", evidence: [], reason: "Invalid thread identifier", nextAction: "Pass the exact valid threadId, then retry the same request." };
  // Saved session settings take precedence over defaults used to create new sessions.
  const config = threadId ? [] : configFiles(path.resolve(codexDirectory), projectPath).map(configEvidence).filter(Boolean);
  const evidence = [...config];
  if (config.some((item) => item.status === "fast"))
    return { ok: false, tier: "fast", evidence, reason: "An inspected configuration explicitly selects an accelerated tier", nextAction: newThreadAction };
  if (config.some((item) => item.status === "unknown"))
    return { ok: false, tier: "unknown", evidence, reason: "The effective configuration policy could not be resolved", nextAction: newThreadAction };
  if (!threadId) {
    const ok = config.some((item) => item.status === "standard");
    return { ok, tier: ok ? "standard" : "unknown", evidence,
      ...(ok ? { scope: "newThreadConfiguration", servedTierVerified: false } : { reason: "No explicit Standard policy was found for new threads", nextAction: newThreadAction }) };
  }
  let tiers = [], unsettledSession = false;
  if (readSessionPolicy) {
    try {
      const current = await readSessionPolicy(threadId);
      if (current?.threadId !== threadId) throw new Error("Desktop policy reader returned a different session");
      if (current.available === true && Object.hasOwn(current, "serviceTier")) {
        tiers.push(current.serviceTier);
        evidence.push({ source: "desktopSessionSettings", kind: "session", tiers: [current.serviceTier],
          protocolVersion: current.protocolVersion, revision: current.revision });
      } else {
        unsettledSession = current.reasonCode === "SESSION_SETTINGS_UNSETTLED";
        evidence.push({ source: "desktopSessionSettings", status: "unavailable", reason: current.reason });
      }
    } catch (error) { evidence.push({ source: "desktopSessionSettings", status: "unavailable", reason: error.message.slice(0, 300) }); }
  }
  if (readThread) {
    try {
      const metadataTiers = tiersFromMetadata(await readThread(threadId));
      tiers.push(...metadataTiers);
      if (metadataTiers.length) evidence.push({ source: "desktopThreadMetadata", kind: "session", tiers: metadataTiers });
    } catch { evidence.push({ source: "desktopThreadMetadata", status: "unavailable" }); }
  }
  if (unsettledSession) return { ok: false, tier: "unknown", evidence, scope: "sessionConfiguration", servedTierVerified: false,
    reasonCode: "SESSION_TIER_UNAVAILABLE", reason: "The desktop session's current settings have not settled",
    nextAction: "Keep setup blocked and preserve its requestId. Retry after the exact session finishes applying its settings; do not use historical tier evidence or toggle the tier repeatedly." };
  if (!tiers.length) {
    const rollout = rolloutEvidence(path.resolve(codexDirectory), threadId);
    if (rollout) { tiers = rollout.tiers; evidence.push(rollout); }
  }
  const states = tiers.map(classify);
  const tier = states.includes("fast") ? "fast" : states.length && states.every((state) => state === "standard") ? "standard" : "unknown";
  const result = { ok: tier === "standard", tier, evidence, scope: "sessionConfiguration", servedTierVerified: false };
  if (tier === "standard") return result;
  if (tier === "fast") return { ...result, reasonCode: "SESSION_TIER_ACCELERATED",
    reason: "The session explicitly selects an accelerated tier", nextAction: sessionAction };
  if (tiers.length) return { ...result, reasonCode: "SESSION_TIER_UNRECOGNIZED",
    reason: "The exposed session tier cannot be classified as Standard", nextAction: "Inspect the exposed session-tier value and host support; keep setup blocked and preserve its requestId." };
  return { ...result, reasonCode: "SESSION_TIER_UNAVAILABLE",
    reason: "No inspected session source exposes an explicit tier; global defaults do not prove its mode", nextAction: unavailableSessionAction };
}

export function assertStandardPolicy(result) {
  if (!result?.ok) throw Object.assign(new Error(result?.reason || "Standard model policy could not be verified"), { code: "STANDARD_TIER_REQUIRED", modelPolicy: result, delivery: "notSent" });
  return result;
}
