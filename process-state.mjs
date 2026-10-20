// Bun 1.2 on Windows reports the libuv ESRCH errno without its symbolic code.
// Permission failures and unrecognized errors must never authorize lock recovery.
export function isMissingProcess(error, platform = process.platform) {
  return error?.code === "ESRCH" || (platform === "win32" && error?.code === "" && error?.errno === -4040 && error?.syscall === "kill");
}
