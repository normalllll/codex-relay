import crypto from "node:crypto";
import { WatchStore } from "./watch-store.mjs";

const pause = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

function deadline(run, timeoutMs, signal, label) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancelled);
      if (error) { controller.abort(); reject(error); } else resolve(value);
    };
    const cancelled = () => finish(new Error(`${label} interrupted; delivery may be uncertain`));
    const timer = setTimeout(() => finish(new Error(`${label} timed out; delivery may be uncertain`)), timeoutMs);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) return cancelled();
    Promise.resolve().then(() => run(controller.signal)).then((value) => finish(null, value), (error) => finish(error));
  });
}

/** Host-independent polling and durable delivery. No model is invoked until wake(). */
export class WatchEngine {
  constructor({ store = new WatchStore(), status, wake, pollMs = 2_000, now = Date.now, ownerId = crypto.randomUUID(), maxDeliveriesPerTick = 16, maxConcurrentPolls = 4, maxConcurrentDeliveries = 4, statusTimeoutMs = 35_000, wakeTimeoutMs = 300_000 } = {}) {
    if (typeof status !== "function" || typeof wake !== "function") throw new Error("WatchEngine requires status and wake functions");
    this.store = store; this.status = status; this.wake = wake; this.pollMs = pollMs; this.now = now;
    this.ownerId = ownerId; this.maxDeliveriesPerTick = maxDeliveriesPerTick;
    this.maxConcurrentPolls = maxConcurrentPolls; this.maxConcurrentDeliveries = maxConcurrentDeliveries;
    this.statusTimeoutMs = statusTimeoutMs; this.wakeTimeoutMs = wakeTimeoutMs;
    if (![pollMs, maxDeliveriesPerTick, maxConcurrentPolls, maxConcurrentDeliveries, statusTimeoutMs, wakeTimeoutMs].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Watch engine intervals and concurrency limits must be positive numbers");
    this.jobs = new Map(); this.runSignal = null;
    this.inTick = null;
    this.store.recoverDispatches({ ownerId, now: now() });
  }

  async tick({ backgroundDeliveries = false } = {}) {
    if (this.inTick) return this.inTick;
    this.inTick = this.performTick({ backgroundDeliveries });
    try { return await this.inTick; } finally { this.inTick = null; }
  }

  async performTick({ backgroundDeliveries }) {
    const result = { observed: 0, added: 0, started: 0, delivered: 0, uncertain: 0, retrying: 0, errors: [] };
    const snapshots = new Map();
    const subscriptions = this.store.list().filter((subscription) => subscription.enabled && (subscription.nextPollAt ?? 0) <= this.now());
    const observe = async (subscription) => {
      try {
        if (!snapshots.has(subscription.threadId)) snapshots.set(subscription.threadId, deadline((signal) => this.status(subscription.threadId, { signal }), this.statusTimeoutMs, this.runSignal, "Watch status"));
        result.added += this.store.observe(subscription.id, await snapshots.get(subscription.threadId), { now: this.now() }).length;
        result.observed++;
      } catch (error) {
        this.store.pollFailed(subscription.id, error, { now: this.now(), retryMs: this.pollMs });
        result.errors.push({ subscriptionId: subscription.id, error: error.message });
      }
    };
    let index = 0;
    const worker = async () => { while (index < subscriptions.length && !this.runSignal?.aborted) await observe(subscriptions[index++]); };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrentPolls, subscriptions.length) }, worker));
    for (let i = 0; i < this.maxDeliveriesPerTick && this.jobs.size < this.maxConcurrentDeliveries && !this.runSignal?.aborted; i++) {
      const claimed = this.store.claimNext({ ownerId: this.ownerId, now: this.now() });
      if (!claimed) break;
      const controller = new AbortController();
      const promise = this.deliver(claimed, result, controller.signal).finally(() => this.jobs.delete(claimed.event.id));
      this.jobs.set(claimed.event.id, { promise, controller });
      result.started++;
    }
    if (!backgroundDeliveries) await Promise.all([...this.jobs.values()].map((job) => job.promise));
    return result;
  }

  async deliver(claimed, result, signal) {
      let outcome;
      try {
        outcome = await deadline((deliverySignal) => this.wake(claimed.subscription, claimed.event, { signal: deliverySignal }), this.wakeTimeoutMs, signal, "Watch host delivery");
        if (!outcome || typeof outcome !== "object") outcome = { error: "Host adapter did not return a delivery receipt" };
      } catch (error) {
        outcome = { delivery: error.delivery, error: error.message };
      }
      let event;
      try { event = this.store.finishDelivery(claimed.event.id, outcome, { ownerId: this.ownerId, now: this.now(), retryMs: this.pollMs }); }
      catch (error) { result.errors.push({ eventId: claimed.event.id, error: error.message }); return; }
      if (event?.phase === "delivered") result.delivered++;
      else if (event?.phase === "uncertain") result.uncertain++;
      else if (event?.phase === "pending") result.retrying++;
  }

  async run({ signal } = {}) {
    if (this.runSignal) throw new Error("Watch engine is already running");
    const local = new AbortController();
    const stop = () => local.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) local.abort();
    this.runSignal = local.signal;
    try {
      while (!local.signal.aborted) {
        await this.tick({ backgroundDeliveries: true });
        await pause(this.pollMs, local.signal);
      }
    } finally {
      signal?.removeEventListener("abort", stop);
      for (const job of this.jobs.values()) job.controller.abort();
      await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
      this.runSignal = null;
    }
  }
}
