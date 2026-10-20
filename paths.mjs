import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

export const relayHome = path.resolve(process.env.CODEX_RELAY_HOME || path.join(os.homedir(), ".codex-relay"));
export const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
export const username = (() => { try { return os.userInfo().username; } catch { return process.env.USERNAME || process.env.USER || crypto.createHash("sha256").update(os.homedir()).digest("hex").slice(0, 16); } })();

// Unix socket paths are limited to about 104 bytes on macOS and 108 on Linux.
const SOCKET_PATH_LIMIT = 100;
export function unixSocket(dir, name) {
  const file = path.join(dir, name);
  if (Buffer.byteLength(file) > SOCKET_PATH_LIMIT)
    throw Object.assign(new Error(`Socket path is too long for this platform: ${file}. Use a shorter CODEX_RELAY_HOME.`), { delivery: "notSent" });
  return file;
}

// Windows keeps the original pipe name for existing installations. Unix sockets live in the
// private relay home, never in a shared temporary directory where another user could claim them.
export function controlPipeFor(home, platform = process.platform) {
  return platform === "win32" ? `\\\\.\\pipe\\codex-relay-${username}` : unixSocket(home, "relay.sock");
}
// Importing must not fail; doctor reports an overlong socket path through controlPipeFor.
export const controlPipe = process.env.CODEX_RELAY_PIPE || (() => { try { return controlPipeFor(relayHome); } catch { return path.join(relayHome, "relay.sock"); } })();
export const tokenFile = path.join(relayHome, "token");

const ownedSocket = (file, uid) => { try { const stat = fs.lstatSync(file); return stat.isSocket() && stat.uid === uid; } catch { return false; } };

// Mirrors the Codex desktop app: a named pipe on Windows; elsewhere CODEX_HOME/ipc/ipc.sock,
// with the earlier per-user temporary socket accepted only when it is privately owned.
export function ipcPipe(env = process.env, platform = process.platform) {
  if (env.CODEX_RELAY_IPC_PIPE) return env.CODEX_RELAY_IPC_PIPE;
  if (platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  const uid = process.getuid?.();
  const primary = path.join(path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex")), "ipc", "ipc.sock");
  if (uid == null || ownedSocket(primary, uid)) return primary;
  const legacy = path.join(os.tmpdir(), "codex-ipc", `ipc-${uid}.sock`);
  try {
    const dir = fs.lstatSync(path.dirname(legacy));
    if (dir.isDirectory() && dir.uid === uid && !(dir.mode & 0o022) && ownedSocket(legacy, uid)) return legacy;
  } catch {}
  return primary;
}

// A crashed Unix listener leaves its socket file behind. Remove it only when nothing accepts connections.
export async function clearStaleSocket(file) {
  if (process.platform === "win32") return false;
  const live = await new Promise((resolve) => {
    const socket = net.createConnection(file);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => resolve(!["ECONNREFUSED", "ENOENT"].includes(error.code)));
  });
  if (live) return false;
  try { if (fs.lstatSync(file).isSocket()) { fs.unlinkSync(file); return true; } } catch {}
  return false;
}

export function restrictSocket(file) {
  if (process.platform !== "win32") try { fs.chmodSync(file, 0o600); } catch {}
}

export function openUrlCommand(url, platform = process.platform) {
  if (platform === "win32") return ["cmd.exe", ["/d", "/c", "start", "", url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}
