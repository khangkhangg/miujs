// The worker loop shared by queues whose jobs live outside the process (Redis, SQLite). A
// backend only stores and leases messages; this file runs them with the same retry, backoff and
// dead-letter rules as memoryQueue.
import type { Env } from "miujs";
import type { JobRow, JobState, QueueAdapter, QueueMessage, QueueRuntime, QueueStats } from "./adapter.ts";
import { realClock, type Clock } from "./clock.ts";
import { queueErrors } from "./errors.ts";
import type { DeadLetter } from "./memory.ts";

/** A message handed to this worker, with the attempt number it is on. */
export interface Claimed {
  msg: QueueMessage;
  attempt: number;
}

export type { QueueStats };

/** Storage for a durable queue. Every method may be called by several processes at once. */
export interface DurableBackend {
  enqueue(msg: QueueMessage, attempt: number, runAt: number, now: number): Promise<void>;
  /** Lease up to `max` messages due at `now` until `leaseUntil`. Each message goes to one caller. */
  claim(now: number, leaseUntil: number, max: number): Promise<Claimed[]>;
  /** Push a lease further out while the job runs. */
  extend(id: string, leaseUntil: number): Promise<void>;
  /** Done: forget the message. */
  ack(id: string): Promise<void>;
  /** Run again at `runAt` as attempt `c.attempt + 1`. */
  retry(c: Claimed, runAt: number, now: number): Promise<void>;
  dead(c: Claimed, letter: DeadLetter): Promise<void>;
  /** Take over messages whose lease ran out before `now` (their worker died or stalled). */
  reap(now: number, leaseUntil: number): Promise<Claimed[]>;
  /** When the next unleased message is due (<= now if one is ready), or undefined if none. */
  nextRunAt(now: number): Promise<number | undefined>;
  /** True for exactly one caller per `key` within `ttlMs`. Used to fire each schedule once. */
  once(key: string, ttlMs: number, now: number): Promise<boolean>;
  stats(now: number): Promise<QueueStats>;
  /** Oldest first. */
  deadLetters(): Promise<DeadLetter[]>;
  /** Delete a message that is not leased (delayed or ready). False when there was none. */
  cancel?(id: string): Promise<boolean>;
  /** Messages in `state` at `now`, the next due first, for the admin. */
  jobs?(state: JobState, now: number, offset: number, limit: number): Promise<JobRow[]>;
  /** Dead letters, newest first. */
  deadPage?(offset: number, limit: number): Promise<DeadLetter[]>;
  /** Remove a dead letter and return it; null when there was none. One caller wins per id. */
  takeDead?(id: string): Promise<DeadLetter | null>;
  close?(): void;
  inspect(): Record<string, unknown>;
}

export interface DurableQueueOptions {
  /** Jobs this process runs at the same time. Default 1. */
  concurrency?: number;
  /**
   * Seconds a running job's lease lasts. The worker renews it while the job runs; if the worker
   * dies, another worker reruns the job (as the next attempt) once the lease runs out. Default 30.
   */
  visibilityTimeout?: number;
  /** How often idle workers look for due jobs, in ms. Default 1000. */
  pollInterval?: number;
  /** Time source. Tests pass `manualClock()`. */
  clock?: Clock;
}

export interface DurableQueue extends QueueAdapter {
  /**
   * Resolve once nothing this store holds is ready, running here, or delayed. On a test clock
   * (`manualClock`), delays and retry backoff are skipped by advancing the clock.
   */
  drain(): Promise<void>;
  /** Stop polling, schedules and lease renewal. Jobs already running finish on their own. */
  stop(): void;
  /** Stop, and close the connection or database this queue opened itself. */
  close(): void;
  /** Messages that failed every attempt (or could never run). Oldest first. */
  listDeadLetters(): Promise<DeadLetter[]>;
  stats(): Promise<QueueStats>;
}

function positive(name: string, label: string, v: unknown, integer: boolean, example: string): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
    throw queueErrors.config(`${name} ${label} must be a positive ${integer ? "integer" : "number"}, got ${String(v)}`, `Pass \`${label}: ${example}\`.`);
  }
}

export function durableQueue(name: string, backend: DurableBackend | (() => DurableBackend), opts: DurableQueueOptions = {}): DurableQueue {
  const concurrency = opts.concurrency ?? 1;
  const visibility = opts.visibilityTimeout ?? 30;
  const pollInterval = opts.pollInterval ?? 1000;
  positive(`${name}Queue`, "concurrency", concurrency, true, "1");
  positive(`${name}Queue`, "visibilityTimeout", visibility, false, "30");
  positive(`${name}Queue`, "pollInterval", pollInterval, false, "1000");
  const leaseMs = visibility * 1000;
  const clock = opts.clock ?? realClock;
  let be: DurableBackend | undefined = typeof backend === "function" ? undefined : backend;
  const store = (): DurableBackend => (be ??= (backend as () => DurableBackend)());
  // What the backend supports, for the admin (a lazily created backend is assumed to support nothing extra).
  const probe: Partial<DurableBackend> = typeof backend === "function" ? {} : backend;

  let rt: QueueRuntime | undefined;
  let running = 0;
  let paused = false; // this process claims nothing while set
  let limit = concurrency;
  let dispatching = 0;
  let active = false; // workers started (setup) and not stopped
  let pollTimer: unknown;
  let kickTimer: ReturnType<typeof setTimeout> | undefined; // one pending "pump soon" after send()
  const scheduleTimers = new Set<unknown>();
  const heartbeats = new Set<unknown>();
  let pumping: Promise<void> | undefined;
  let again = false;
  let pumpError: unknown; // last poll failure, surfaced by drain()
  let waiters: (() => void)[] = [];

  const notify = () => {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };
  const runtime = (): QueueRuntime => {
    if (!rt) throw queueErrors.config(`${name}Queue is not attached to a queue()`, `Pass it as \`queue({ adapter: ${name}Queue(...) })\`.`);
    return rt;
  };

  const deadLetter = (c: Claimed, error: unknown): DeadLetter => {
    const e = error as { message?: unknown; code?: unknown };
    return {
      id: c.msg.id,
      job: c.msg.job,
      input: c.msg.input,
      attempts: c.attempt,
      error: typeof e?.message === "string" ? e.message : String(error),
      code: typeof e?.code === "string" ? e.code : undefined,
      failedAt: clock.now(),
    };
  };

  const start = (c: Claimed, env: Env) => {
    running++;
    const renew = () => {
      const h = clock.setTimeout(() => {
        heartbeats.delete(h);
        if (!active) return;
        store()
          .extend(c.msg.id, clock.now() + leaseMs)
          .catch((err) => runtime().log.warn("could not renew job lease", { jobId: c.msg.id, err }));
        renew();
      }, leaseMs / 3);
      (h as { unref?: () => void } | null)?.unref?.();
      heartbeats.add(h);
      stopRenew = () => {
        clock.clearTimeout(h);
        heartbeats.delete(h);
      };
    };
    let stopRenew = () => {};
    renew();
    runtime()
      .run(c.msg, c.attempt, env)
      .then(async (res) => {
        stopRenew();
        if (res.ok) await store().ack(c.msg.id);
        else if (res.retry) await store().retry(c, clock.now() + res.delaySeconds * 1000, clock.now());
        else await store().dead(c, deadLetter(c, res.error));
      })
      .catch((err) => runtime().log.error("queue bookkeeping failed; the job may run again", { jobId: c.msg.id, err }))
      .finally(() => {
        stopRenew();
        running--;
        // After stop()/close() a finishing job must not make this worker claim more (or reopen
        // the database close() just closed); drain() pumps by itself.
        if (active) void pump();
        else notify();
      });
  };

  // A message whose lease ran out: rerun it as the next attempt, or dead-letter it.
  const expired = async (c: Claimed, now: number) => {
    const r = runtime();
    const job = r.jobs.get(c.msg.job);
    if (job && c.attempt < job.maxAttempts) {
      r.log.warn("job lease expired (worker stopped or job too slow); running it again", { job: c.msg.job, jobId: c.msg.id, attempt: c.attempt });
      await store().retry(c, now, now);
    } else {
      const err = queueErrors.timeout(c.msg.job, visibility);
      r.log.error(err.message, { jobId: c.msg.id, code: err.code });
      await store().dead(c, deadLetter(c, err));
    }
  };

  const pumpOnce = async () => {
    const r = runtime();
    const now = clock.now();
    for (const c of await store().reap(now, now + leaseMs)) await expired(c, now);
    const free = limit - running;
    if (paused || free <= 0) return;
    const claimed = await store().claim(now, now + leaseMs, free);
    const env = r.defaultEnv();
    for (const c of claimed) start(c, env);
  };

  const pump = (): Promise<void> => {
    if (!rt) return Promise.resolve();
    if (pumping) {
      again = true;
      return pumping;
    }
    pumping = (async () => {
      do {
        again = false;
        await pumpOnce();
      } while (again);
    })()
      .then(
        () => void (pumpError = undefined),
        (err) => {
          pumpError = err;
          runtime().log.error("queue poll failed", { err });
        },
      )
      .finally(() => {
        pumping = undefined;
        notify();
      });
    return pumping;
  };

  const poll = () => {
    pollTimer = clock.setTimeout(() => {
      pollTimer = undefined;
      if (!active) return;
      void pump();
      poll();
    }, pollInterval);
    (pollTimer as { unref?: () => void } | null)?.unref?.();
  };

  const tickSchedules = (minute: number) => {
    const r = runtime();
    const date = new Date(minute);
    for (const s of r.schedules) {
      if (!s.cron.matches(date)) continue;
      dispatching++;
      store()
        .once(`${minute}:${s.cron.source}:${s.job.name}`, 120_000, clock.now())
        .then((mine) => {
          if (!mine) return;
          r.fired?.(s, minute);
          return r.dispatch(s.job, s.input, undefined, r.defaultEnv());
        })
        .catch((err) => r.log.error("scheduled dispatch failed", { job: s.job.name, cron: s.cron.source, err }))
        .finally(() => {
          dispatching--;
          notify();
        });
    }
  };

  const armSchedules = () => {
    const now = clock.now();
    const next = Math.floor(now / 60_000) * 60_000 + 60_000;
    const h = clock.setTimeout(() => {
      scheduleTimers.delete(h);
      tickSchedules(next);
      if (active && runtime().schedules.length) armSchedules();
    }, next - now);
    (h as { unref?: () => void } | null)?.unref?.();
    scheduleTimers.add(h);
  };

  const stop = () => {
    active = false;
    if (pollTimer !== undefined) clock.clearTimeout(pollTimer);
    pollTimer = undefined;
    if (kickTimer !== undefined) clearTimeout(kickTimer);
    kickTimer = undefined;
    for (const h of [...scheduleTimers, ...heartbeats]) clock.clearTimeout(h);
    scheduleTimers.clear();
    heartbeats.clear();
    notify();
  };

  return {
    name,
    attach(r) {
      if (rt) throw queueErrors.config(`This ${name}Queue() is already used by another queue()`, `Create one ${name}Queue() per queue() plugin.`);
      rt = r;
    },
    async send(msg, o, _env) {
      const now = clock.now();
      await store().enqueue(msg, 1, now + (o.delay ?? 0) * 1000, now);
      // Next macrotask, so job code never runs inside the dispatching request's await chain.
      // One timer however many sends arrive before it fires.
      if (active && kickTimer === undefined) {
        kickTimer = setTimeout(() => {
          kickTimer = undefined;
          if (active) void pump();
        }, 0);
      }
    },
    setup() {
      if (active) return;
      active = true;
      if (runtime().schedules.length) armSchedules();
      poll();
      void pump();
    },
    stop,
    schedulesChanged() {
      if (!active) return;
      if (runtime().schedules.length) {
        if (scheduleTimers.size === 0) armSchedules();
      } else {
        for (const h of scheduleTimers) clock.clearTimeout(h);
        scheduleTimers.clear();
      }
    },
    async cancel(id) {
      const b = store();
      if (!b.cancel) throw queueErrors.config(`This ${name} backend cannot cancel messages`, "Implement cancel(id) in the DurableBackend.");
      const ok = await b.cancel(id);
      if (ok) notify();
      return ok;
    },
    close() {
      stop();
      be?.close?.();
    },
    async drain() {
      for (;;) {
        await pump();
        if (pumpError) throw pumpError;
        if (running || dispatching || pumping || paused) {
          await new Promise<void>((r) => waiters.push(r));
          continue;
        }
        const next = await store().nextRunAt(clock.now());
        if (next === undefined) return;
        if (next <= clock.now()) continue;
        if (clock.advanceTo) clock.advanceTo(next);
        else await new Promise((r) => setTimeout(r, Math.min(next - clock.now(), pollInterval)));
      }
    },
    listDeadLetters: () => store().deadLetters(),
    ...(probe.jobs ? { listJobs: (state: JobState, offset: number, n: number) => store().jobs!(state, clock.now(), offset, n) } : {}),
    ...(probe.deadPage ? { listDead: (offset: number, n: number) => store().deadPage!(offset, n) } : {}),
    ...(probe.takeDead
      ? {
          async retryDead(id: string) {
            const d = await store().takeDead!(id);
            if (!d) return false;
            const now = clock.now();
            await store().enqueue({ id: d.id, job: d.job, input: d.input }, 1, now, now);
            if (active) void pump();
            return true;
          },
          deleteDead: async (id: string) => (await store().takeDead!(id)) !== null,
        }
      : {}),
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      notify();
      if (active) void pump();
    },
    isPaused: () => paused,
    getConcurrency: () => limit,
    setConcurrency(n: number) {
      positive(`${name}Queue`, "concurrency", n, true, "1");
      limit = n;
      if (active) void pump();
    },
    now: () => clock.now(),
    stats: () => store().stats(clock.now()),
    inspect: () => ({ ...(be ?? store()).inspect(), concurrency: limit, visibilityTimeout: visibility, pollInterval, running }),
    cloudflare: () => ({}),
  };
}
