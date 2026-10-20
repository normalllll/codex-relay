// Backward-compatible low-level diagnostic entry. Prefer cli.mjs for workflows.
import { relay } from "./transport.mjs";
const [command, ...rest] = process.argv.slice(2);
try {
  let result;
  if (command === "info") result = await relay("relay/info");
  else if (command === "list") result = await relay("tools/list");
  else if (command === "call") {
    const [tool, threadId, args, namespace = "codex_app"] = rest;
    if (!tool || !threadId) throw new Error("call requires tool and caller threadId");
    result = await relay("tools/call", { tool, threadId, namespace, arguments: args ? JSON.parse(args) : {} });
  } else throw new Error("usage: info | list | call <tool> <callerThreadId> [jsonArguments] [namespace]");
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
