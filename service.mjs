// Stable login launcher: resolve the current immutable release after every update.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const home = path.dirname(fileURLToPath(import.meta.url));
try {
  const state = JSON.parse(fs.readFileSync(path.join(home, "install.json"), "utf8"));
  if (!state.runtime || !path.isAbsolute(state.runtime) || !state.release || !path.isAbsolute(state.release)) throw new Error("Invalid service installation record");
  const child = spawn(state.runtime, [path.join(state.release, "daemon.mjs"), "supervise"], {
    env: { ...process.env, CODEX_RELAY_HOME: home, CODEX_HOME: path.dirname(state.codexConfig) }, windowsHide: true, stdio: "inherit",
  });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
