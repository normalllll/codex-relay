import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { relayHome } from "./paths.mjs";
import { isMissingProcess } from "./process-state.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return !isMissingProcess(error); } };
const atomic = (file, data) => {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try { fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
};

export class ReplyOutbox {
  constructor(home = relayHome) { this.dir = path.join(home, "outgoing"); }

  inspect(requestId) {
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200) throw new Error("Invalid requestId");
    const file = path.join(this.dir, `${hash(requestId)}.json`);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { requestId, status: "unknown" }; throw error; }
  }

  async execute(requestId, args, run) {
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200) throw new Error("requestId must contain 1..200 characters");
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${hash(requestId)}.json`);
    const lock = `${file}.lock`;
    const nonce = crypto.randomUUID();
    let acquired = false;
    for (let i = 0; i < 2; i++) {
      try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx" }); acquired = true; break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); } catch { throw new Error("Outgoing request lock is unreadable; inspect it before recovery"); }
        if (alive(owner.pid)) throw new Error("This requestId is already being processed");
        fs.unlinkSync(lock);
      }
    }
    if (!acquired) throw new Error("Could not acquire outgoing request lock");
    try {
      const fingerprint = hash(JSON.stringify(canonical(args)));
      const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { requestId, fingerprint, stages: {}, createdAt: new Date().toISOString() };
      if (state.fingerprint !== fingerprint) throw new Error("requestId was already used for different input");
      if (state.result) return { ...state.result, replayed: true };
      const transaction = {
        stage: async (name, operation) => {
          const old = state.stages[name];
          if (old?.phase === "delivered") return old.result;
          if (old && ["dispatching", "uncertain"].includes(old.phase))
            throw Object.assign(new Error(`Delivery of ${name} is uncertain. Check the target before creating a replacement request; it was not automatically resent.`), { delivery: "uncertain", requestId });
          state.stages[name] = { phase: "dispatching", startedAt: new Date().toISOString() }; atomic(file, state);
          try {
            const result = await operation();
            state.stages[name] = { phase: "delivered", result, finishedAt: new Date().toISOString() }; atomic(file, state);
            return result;
          } catch (error) {
            state.stages[name] = { phase: error.delivery === "notSent" ? "notSent" : "uncertain", error: error.message }; atomic(file, state);
            throw error;
          }
        },
      };
      const result = { ...await run(transaction), requestId };
      state.result = result; atomic(file, state);
      return result;
    } catch (error) { error.requestId ??= requestId; throw error; }
    finally {
      try { if (JSON.parse(fs.readFileSync(lock, "utf8")).nonce === nonce) fs.unlinkSync(lock); } catch {}
    }
  }
}
