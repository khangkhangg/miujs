import type { QueueAdapter, QueueMessage, QueueRuntime } from "./adapter.ts";
import { realClock, type Clock } from "./clock.ts";
import { queueErrors } from "./errors.ts";
import type { Env } from "miujs";

export interface MemoryQueueOptions {
  /** Jobs run at the same time. Default 1. */
  concurrency?: number;
  /** Time source for delays, backoff and schedules. Tests pass `manualClock()`. */
  clock?: Clock;
  /** Dead letters kept in memory; older ones are dropped first. Default 1000. */
  maxDeadLetters?: number;
}

export interface DeadLetter {
  id: string;
  job: string;
  input: unknown;
  attempts: number;
  /** Error message of the last attempt. */
  error: string;
  /** MiuError code of the last error, when it had one. */
  code?: string;
  failedAt: number;
}

export interface MemoryQueue extends QueueAdapter {
  /** Messages that failed every attempt (or could never run), at most `maxDeadLetters`. Newest last. */
  readonly deadLetters: DeadLetter[];
  /**
   * Resolve once nothing is queued, running or delayed. On a test clock (`manualClock`), delays
   * and retry backoff are skipped by advancing the clock; on the real clock they are waited for.
   */
  drain(): Promise<void>;
  stop(): void;
}

interface Item {
  msg: QueueMessage;
  attempt: number;
  env: Env;
}

/**
 * In-process queue: the default on Bun, Deno and Node. Jobs run in this process, so they are
 * lost if it exits. Good for development, tests and single-server apps.
 */
export function memoryQueue(opts: MemoryQueueOptions = {}): MemoryQueue {
  const concurrency = opts.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw queueErrors.config(`memoryQueue concurrency must be a positive integer, got ${String(concurrency)}`, "Pass `concurrency: 1` or more.");
  }
  const maxDeadLetters = opts.maxDeadLetters ?? 1000;
  if (!Number.isInteger(maxDeadLetters) || maxDeadLetters < 0) {
    throw queueErrors.config(`memoryQueue maxDeadLetters must be a whole number >= 0, got ${String(maxDeadLetters)}`, "Pass `maxDeadLetters: 1000` (0 keeps none).");
  }
  const clock = opts.clock ?? realClock;
  let rt: QueueRuntime | undefined;
  const ready: Item[] = [];
  const delayed = new Map<unknown, number>(); // timer handle -> due time
  const delayedById = new Map<string, unknown>(); // message id -> timer handle (for cancel)
  let started = false; // setup() ran and stop() did not
  const scheduleTimers = new Set<unknown>();
  const deadLetters: DeadLetter[] = [];
  let running = 0;
  let dispatching = 0; // scheduled dispatches not yet enqueued
  let pumpQueued = false;
  let waiters: (() => void)[] = [];

  const notify = () => {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };

  const runtime = (): QueueRuntime => {
    if (!rt) throw queueErrors.config("memoryQueue is not attached to a queue()", "Pass it as `queue({ adapter: memoryQueue() })`.");
    return rt;
  };

  const pump = () => {
    pumpQueued = false;
    while (running < concurrency && ready.length) start(ready.shift()!);
    notify();
  };
  const schedulePump = () => {
    if (pumpQueued) return;
    pumpQueued = true;
    // Next macrotask, so job code never runs inside the dispatching request's await chain.
    setTimeout(pump, 0);
  };

  const enqueue = (item: Item, delayMs: number) => {
    if (delayMs <= 0) {
      ready.push(item);
      schedulePump();
      return;
    }
    const h = clock.setTimeout(() => {
      delayed.delete(h);
      if (delayedById.get(item.msg.id) === h) delayedById.delete(item.msg.id);
      ready.push(item);
      schedulePump();
    }, delayMs);
    // A waiting delay or retry backoff does not keep the process alive (like schedules): an
    // in-process queue loses pending jobs on exit anyway. Use a durable queue to keep them.
    (h as { unref?: () => void } | null)?.unref?.();
    delayed.set(h, clock.now() + delayMs);
    delayedById.set(item.msg.id, h);
  };

  const deadLetter = (item: Item, error: unknown) => {
    const e = error as { message?: unknown; code?: unknown };
    deadLetters.push({
      id: item.msg.id,
      job: item.msg.job,
      input: item.msg.input,
      attempts: item.attempt,
      error: typeof e?.message === "string" ? e.message : String(error),
      code: typeof e?.code === "string" ? e.code : undefined,
      failedAt: clock.now(),
    });
    // Bounded, so a job that keeps failing cannot grow memory forever.
    if (deadLetters.length > maxDeadLetters) deadLetters.splice(0, deadLetters.length - maxDeadLetters);
  };

  const start = (item: Item) => {
    running++;
    runtime()
      .run(item.msg, item.attempt, item.env)
      .then((res) => {
        if (res.ok) return;
        if (res.retry) enqueue({ ...item, attempt: item.attempt + 1 }, res.delaySeconds * 1000);
        else deadLetter(item, res.error);
      })
      .catch((err) => deadLetter(item, err))
      .finally(() => {
        running--;
        pump();
      });
  };

  const tickSchedules = (minute: number) => {
    const r = runtime();
    const date = new Date(minute);
    for (const s of r.schedules) {
      if (!s.cron.matches(date)) continue;
      dispatching++;
      r.dispatch(s.job, s.input, undefined, r.defaultEnv())
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
      if (runtime().schedules.length) armSchedules();
    }, next - now);
    (h as { unref?: () => void } | null)?.unref?.(); // don't keep a script alive just for cron
    scheduleTimers.add(h);
  };

  return {
    name: "memory",
    deadLetters,
    attach(r) {
      if (rt) throw queueErrors.config("This memoryQueue() is already used by another queue()", "Create one memoryQueue() per queue() plugin.");
      rt = r;
    },
    async send(msg, o, env) {
      enqueue({ msg, attempt: 1, env }, (o.delay ?? 0) * 1000);
    },
    setup() {
      started = true;
      if (runtime().schedules.length && scheduleTimers.size === 0) armSchedules();
    },
    schedulesChanged() {
      if (!started) return;
      if (runtime().schedules.length) {
        if (scheduleTimers.size === 0) armSchedules();
      } else {
        for (const h of scheduleTimers) clock.clearTimeout(h);
        scheduleTimers.clear();
      }
    },
    async cancel(id) {
      const h = delayedById.get(id);
      if (h !== undefined) {
        clock.clearTimeout(h);
        delayedById.delete(id);
        delayed.delete(h);
        notify();
        return true;
      }
      const i = ready.findIndex((it) => it.msg.id === id);
      if (i === -1) return false;
      ready.splice(i, 1);
      notify();
      return true;
    },
    stop() {
      started = false;
      for (const h of scheduleTimers) clock.clearTimeout(h);
      scheduleTimers.clear();
      for (const h of delayed.keys()) clock.clearTimeout(h);
      delayed.clear();
      delayedById.clear();
      notify();
    },
    async drain() {
      for (;;) {
        if (!ready.length && !running && !dispatching) {
          if (!delayed.size) return;
          if (clock.advanceTo) {
            clock.advanceTo(Math.min(...delayed.values()));
            continue;
          }
        }
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    inspect: () => ({ concurrency, pending: ready.length, running, delayed: delayed.size, deadLetters: deadLetters.length }),
    cloudflare: () => ({}),
  };
}
