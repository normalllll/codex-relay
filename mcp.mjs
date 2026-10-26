import { createInterface } from "node:readline";
import { tools, runTool } from "./src/tasks/tools.mjs";
import { connectChannel, startService } from "./src/watch/daemon-client.mjs";
import { followupTools } from "./src/watch/host-wake.mjs";

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
    serverInfo: { name: "codex-relay", version: "0.6.0" },
    instructions: "Codex Relay provides local chat task tools. Use the installed codex-relay Skill when the user requests delegation or supervision, or when continuing an existing Relay wake. Tool availability alone does not assign this chat a supervisory role.",
  });
  if (message.method === "ping") return reply({});
  if (message.method === "tools/list") {
    const allowed = process.env.CODEX_RELAY_WAKE_EVENT_ID ? new Set(followupTools) : null;
    return reply({ tools: Object.entries(tools).filter(([name]) => !allowed || allowed.has(name)).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })) });
  }
  if (message.method === "tools/call") {
    try { return reply({ content: [{ type: "text", text: JSON.stringify(await runTool(message.params?.name, message.params?.arguments ?? {}, { bindChannel, fromMcp: true })) }] }); }
    catch (error) { return reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code, modelPolicy: error.modelPolicy, requestId: error.requestId ?? message.params?.arguments?.requestId, delivery: error.delivery }) }] }); }
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
