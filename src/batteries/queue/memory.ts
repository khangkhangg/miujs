import type { Job, QueueDriver } from "./types.ts";

/** In-process queue driver. Per-instance only: jobs are lost on restart. */
export function memoryQueueDriver(): QueueDriver {
  const jobs = new Map<string, Job & { lockedUntil?: number }>();
  // Payloads are stored serialized, matching durable drivers.
  const copy = (j: Job & { lockedUntil?: number }): Job => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j)) if (v !== undefined && k !== "lockedUntil") out[k] = v;
    out.payload = JSON.parse(JSON.stringify(j.payload ?? null));
    return out as unknown as Job;
  };
  const byRunAt = () => [...jobs.values()].sort((a, b) => a.runAt - b.runAt);

  const findPendingByKey = (key: string) => {
    for (const j of jobs.values()) if (j.status === "pending" && j.key === key) return j;
    return undefined;
  };

  return {
    async push(job) {
      const existing = job.key === undefined ? undefined : findPendingByKey(job.key);
      if (existing) return copy(existing);
      const stored = copy(job);
      jobs.set(job.id, stored);
      return copy(stored);
    },
    async claim(now, lockMs) {
      const j = byRunAt().find(
        (j) => (j.status === "pending" && j.runAt <= now) || (j.status === "running" && (j.lockedUntil ?? 0) <= now),
      );
      if (!j) return undefined;
      j.status = "running";
      j.lockedUntil = now + lockMs;
      j.attempts++;
      return copy(j);
    },
    async complete(id, now) {
      const j = jobs.get(id);
      if (!j) return;
      j.status = "completed";
      j.finishedAt = now;
      j.lockedUntil = undefined;
    },
    async fail(id, error, nextRunAt, now) {
      const j = jobs.get(id);
      if (!j) return;
      j.lastError = error;
      j.lockedUntil = undefined;
      if (nextRunAt === null) {
        j.status = "failed";
        j.finishedAt = now;
      } else {
        j.status = "pending";
        j.runAt = nextRunAt;
      }
    },
    async get(id) {
      const j = jobs.get(id);
      return j && copy(j);
    },
    async list(opts = {}) {
      const out = byRunAt().filter((j) => !opts.status || j.status === opts.status);
      return out.slice(0, opts.limit ?? out.length).map(copy);
    },
    async findPendingByKey(key) {
      const j = findPendingByKey(key);
      return j && copy(j);
    },
    async retry(id, now) {
      const j = jobs.get(id);
      if (!j || j.status !== "failed") return false;
      Object.assign(j, { status: "pending", attempts: 0, runAt: now, finishedAt: undefined });
      return true;
    },
    async prune(before) {
      let n = 0;
      for (const [id, j] of jobs) {
        if (j.status === "completed" && (j.finishedAt ?? 0) <= before) {
          jobs.delete(id);
          n++;
        }
      }
      return n;
    },
    async close() {},
  };
}
