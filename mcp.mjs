import { createInterface } from "node:readline";
import { tools, runTool } from "./tools.mjs";
import { connectChannel, startService } from "./daemon-client.mjs";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let closeChannel, boundSession, closed = false;
const sessionArgument = process.argv.indexOf("--channel-session");
const configuredSession = sessionArgument >= 0 ? process.argv[sessionArgument + 1] : process.env.CODEX_RELAY_CHANNEL_SESSION_ID;
async function bindChannel(sessionId) {
  if (closed) throw new Error("MCP input is closed");
  if (boundSession === sessionId) return;
  closeChannel?.(); boundSession = sessionId;
  closeChannel = connectChannel(sessionId, (event) => new Promise((resolve, reject) => {
    const notification = { jsonrpc: "2.0", method: "notifications/claude/channel", params: {
      content: event.content, meta: { event_id: event.eventId, subscription_id: event.subscriptionId, thread_id: event.threadId },
    } };
    process.stdout.write(`${JSON.stringify(notification)}\n`, (error) => error ? reject(error) : resolve());
  }), { onError: (error) => process.stderr.write(`Relay channel: ${error.message}\n`) });
}
const input = createInterface({ input: process.stdin });
input.on("close", () => { closed = true; closeChannel?.(); });
input.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  if (!message || typeof message !== "object" || Array.isArray(message))
    return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  if (message.method === "notifications/initialized" && configuredSession) {
    try { await startService(); await bindChannel(configuredSession); }
    catch (error) { process.stderr.write(`Relay channel startup: ${error.message}\n`); }
  }
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") return reply({
    protocolVersion: "2025-06-18", capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    serverInfo: { name: "codex-relay", version: "0.5.0" },
    instructions: "For a user requesting a new or selected execution chat, a task and completion criteria, use codex_supervise as the default. The current chat supervises a separate execution chat. Always read installed CLI host in the current agent shell once for setup and pass its supported identity fields as supervisor: shared MCP startup identity can be stale. The composite checks readiness, selects wake capability and registers durable follow-up. Choose a stable requestId once for retries. Entire sessions use Standard mode, checked at creation/takeover; later messages inherit their settings. Do not enable Fast or treat unknown tiers as Standard. Report real environment blockers without asking the user to choose tools. Use Relay MCP for messages. On watch events fetch codex_events, inspect codex_status, handle within delegated scope with codex_reply(requestId=event ID plus action), then codex_watch_ack(rearm or complete). Never repeat acknowledged events, fabricate human answers, approve commands, or implicitly enable untrusted channels.",
  });
  if (message.method === "ping") return reply({});
  if (message.method === "tools/list") {
    const allowed = process.env.CODEX_RELAY_WAKE_EVENT_ID ? new Set(["codex_events", "codex_status", "codex_reply", "codex_watch_ack", "codex_delivery"]) : null;
    return reply({ tools: Object.entries(tools).filter(([name]) => !allowed || allowed.has(name)).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })) });
  }
  if (message.method === "tools/call") {
    try { return reply({ content: [{ type: "text", text: JSON.stringify(await runTool(message.params?.name, message.params?.arguments ?? {}, { bindChannel, fromMcp: true })) }] }); }
    catch (error) { return reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code, modelPolicy: error.modelPolicy, requestId: error.requestId ?? message.params?.arguments?.requestId, delivery: error.delivery }) }] }); }
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
