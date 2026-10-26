import fs from "node:fs";
import net from "node:net";
import { controlPipe, tokenFile } from "../runtime/paths.mjs";

export function relay(method, params, { timeoutMs = 35_000, signal } = {}) {
  if (signal?.aborted) throw new Error("Relay wait cancelled");
  let token;
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); }
  catch { throw Object.assign(new Error("Relay token is missing. Run doctor; the Codex desktop bridge must start before using Relay."), { delivery: "notSent" }); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPipe);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let attempted = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) { error.delivery ??= attempted ? "uncertain" : "notSent"; reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`Relay request timed out after ${timeoutMs}ms; delivery may be uncertain. Check status before retrying a write.`)), timeoutMs);
    const onAbort = () => finish(new Error("Relay wait cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => finish(new Error(`Codex Relay is not reachable: ${error.message}. Run doctor; reload Codex desktop after first installation.`)));
    socket.once("connect", () => { attempted = true; socket.write(`${JSON.stringify({ id: 1, token, method, params })}\n`); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return finish(new Error("Relay response exceeds 8 MiB"));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        finish(response.error ? Object.assign(new Error(response.error.message), { code: response.error.code, delivery: response.error.delivery }) : null, response.result);
      } catch (error) { finish(error); }
    });
    socket.once("close", () => { if (!settled) finish(new Error("Relay disconnected before responding; check status before retrying a write.")); });
  });
}
