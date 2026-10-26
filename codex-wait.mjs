// Background wait for a Codex thread, for Claude Code to run as a background shell command so
// the conversation stays responsive. Exits with one compact JSON line when the turn ends, Codex
// asks a question, the thread needs attention, or the timeout passes.
// usage: node codex-wait.mjs <threadId> [timeoutMinutes=60] [--past-attention]
// --past-attention: the thread's current attention flags (for example an approval waiting for the
// user in Codex) were already reported; keep waiting until they change instead of exiting at once.
import { wait } from "./src/desktop/codex-client.mjs";

const args = process.argv.slice(2);
const pastAttention = args.includes("--past-attention");
const [threadId, timeoutMinutes = "60"] = args.filter((arg) => !arg.startsWith("--"));
if (!threadId) {
  console.error("usage: node codex-wait.mjs <threadId> [timeoutMinutes] [--past-attention]");
  process.exit(64);
}
try {
  console.log(JSON.stringify(await wait(threadId, Number(timeoutMinutes), { pastAttention })));
} catch (error) {
  console.log(JSON.stringify({ threadId, reason: "error", error: error.message }));
  process.exitCode = 1;
}
