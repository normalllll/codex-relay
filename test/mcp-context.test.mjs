import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("shared MCP discovery does not assign the loading chat a supervisor role", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env, CODEX_HOME: path.join(dir, "codex"), CODEX_RELAY_HOME: path.join(dir, "relay"),
    CODEX_RELAY_CHANNEL_SESSION_ID: "", CODEX_RELAY_WAKE_EVENT_ID: "",
  };
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], {
    env, input: requests.map(JSON.stringify).join("\n") + "\n", encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const initialized = responses.find((response) => response.id === 1).result;
  assert.equal(initialized.serverInfo.name, "codex-relay");
  assert.ok(initialized.instructions.length < 400, "shared discovery must not carry the supervision workflow");
  assert.match(initialized.instructions, /installed codex-relay Skill/);
  assert.match(initialized.instructions, /when the user requests/);
  assert.doesNotMatch(initialized.instructions, /current chat supervises|authority established|answer routine|codex_watch_ack|codex_reply/i);
  const names = responses.find((response) => response.id === 2).result.tools.map((tool) => tool.name);
  for (const name of ["codex_supervise", "codex_reply", "codex_event_context", "codex_watch_ack"]) assert.ok(names.includes(name));
});
