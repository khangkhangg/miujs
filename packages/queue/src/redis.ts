import type { JobRow, JobState, QueueMessage } from "./adapter.ts";
import { durableQueue, type Claimed, type DurableBackend, type DurableQueue, type DurableQueueOptions } from "./durable.ts";
import { queueErrors } from "./errors.ts";
import type { DeadLetter } from "./memory.ts";

/** The Redis commands redisQueue uses. `bunRedis()` from @miujs/cache satisfies it. */
export interface QueueRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { px?: number; nx?: boolean }): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrangebyscore(key: string, min: number, max: number, limit?: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<number>;
  zscore(key: string, member: string): Promise<number | null>;
  zcard(key: string): Promise<number>;
  lpush(key: string, value: string): Promise<number>;
  rpoplpush(src: string, dst: string): Promise<string | null>;
  lrem(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  close?(): void;
  inspect?(): Record<string, unknown>;
}

const METHODS = ["get", "set", "del", "zadd", "zrangebyscore", "zrem", "zscore", "zcard", "lpush", "rpoplpush", "lrem", "lrange", "llen"] as const;

export interface RedisQueueOptions extends DurableQueueOptions {
  /** Prepended to every key. Default "miu:queue:". */
  prefix?: string;
}

/** Dead letters searched for an id by retry/delete when it has no index entry (newest first). */
const DEAD_SCAN = 10_000;

function parseDead(s: string): DeadLetter | undefined {
  try {
    return JSON.parse(s) as DeadLetter;
  } catch {
    return undefined;
  }
}

const FIX = "Check that Redis is running and reachable at REDIS_URL (or the url passed to bunRedis()), with the right credentials and TLS settings.";

/*
 * Keys (under the prefix):
 *   job:<id>    JSON { msg, attempt }        the message and the attempt it is on
 *   ready       list of ids                  due now; LPUSH in, RPOPLPUSH out (FIFO)
 *   processing  list of ids                  leased by some worker
 *   lease:<id>  deadline in ms               a lease; missing right after RPOPLPUSH
 *   reap:<id>   lock (PX)                    one reaper per expired lease
 *   delayed     sorted set id -> run-at ms   delays and retry backoff
 *   dead        list of DeadLetter JSON      newest at the head
 *   deadid:<id> the exact JSON in dead       index for retry/delete by id; letters written
 *                                            before it existed are found by scanning dead
 *   once:<key>  lock (PX)                    one schedule firing per minute
 * No MULTI or EVAL: every hand-off is a single atomic command (RPOPLPUSH, ZREM, SET NX), and
 * writes are ordered so a crash can duplicate a message but never lose one.
 */
function redisBackend(client: QueueRedisLike, prefix: string): DurableBackend {
  const k = {
    job: (id: string) => `${prefix}job:${id}`,
    lease: (id: string) => `${prefix}lease:${id}`,
    reap: (id: string) => `${prefix}reap:${id}`,
    ready: `${prefix}ready`,
    processing: `${prefix}processing`,
    delayed: `${prefix}delayed`,
    dead: `${prefix}dead`,
    deadId: (id: string) => `${prefix}deadid:${id}`,
    once: (key: string) => `${prefix}once:${key}`,
  };
  const g =
    <A extends unknown[], R>(op: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await fn(...a);
      } catch (err) {
        throw queueErrors.backend("REDIS", op, err, FIX);
      }
    };

  const load = async (id: string): Promise<Claimed | null> => {
    const text = await client.get(k.job(id));
    if (text === null) return null;
    try {
      return JSON.parse(text) as Claimed;
    } catch {
      return null;
    }
  };
  const place = async (id: string, runAt: number, now: number) => {
    if (runAt <= now) await client.lpush(k.ready, id);
    else await client.zadd(k.delayed, runAt, id);
  };
  const release = async (id: string) => {
    await client.lrem(k.processing, id);
    await client.del(k.lease(id), k.reap(id));
  };
  // Move due delayed ids to ready. ZREM decides which worker moves each one.
  const promote = async (now: number) => {
    for (const id of await client.zrangebyscore(k.delayed, -Infinity, now, 100)) {
      if ((await client.zrem(k.delayed, id)) === 1) await client.lpush(k.ready, id);
    }
  };

  return {
    enqueue: g("enqueue", async (msg: QueueMessage, attempt: number, runAt: number, now: number) => {
      await client.set(k.job(msg.id), JSON.stringify({ msg, attempt }));
      await place(msg.id, runAt, now);
    }),
    claim: g("claim", async (now: number, leaseUntil: number, max: number) => {
      await promote(now);
      const out: Claimed[] = [];
      while (out.length < max) {
        const id = await client.rpoplpush(k.ready, k.processing);
        if (id === null) break;
        await client.set(k.lease(id), String(leaseUntil));
        const c = await load(id);
        if (c) out.push(c);
        else await release(id); // acked elsewhere (e.g. it ran after a lease takeover)
      }
      return out;
    }),
    extend: g("extend", async (id: string, leaseUntil: number) => {
      await client.set(k.lease(id), String(leaseUntil));
    }),
    ack: g("ack", async (id: string) => {
      await client.del(k.job(id));
      await release(id);
    }),
    retry: g("retry", async (c: Claimed, runAt: number, now: number) => {
      await client.set(k.job(c.msg.id), JSON.stringify({ msg: c.msg, attempt: c.attempt + 1 }));
      await place(c.msg.id, runAt, now);
      await release(c.msg.id);
    }),
    dead: g("dead-letter", async (c: Claimed, letter: DeadLetter) => {
      const raw = JSON.stringify(letter);
      // Index first: an index entry without its letter (a crash in between) reads as not found.
      await client.set(k.deadId(letter.id), raw);
      await client.lpush(k.dead, raw);
      await client.del(k.job(c.msg.id));
      await release(c.msg.id);
    }),
    reap: g("reap", async (now: number, leaseUntil: number) => {
      const out: Claimed[] = [];
      for (const id of await client.lrange(k.processing, 0, -1)) {
        const deadline = await client.get(k.lease(id));
        if (deadline === null) {
          // Just popped and not leased yet, or its worker died in between: give it one lease.
          await client.set(k.lease(id), String(leaseUntil), { nx: true });
          continue;
        }
        if (Number(deadline) > now) continue;
        if (!(await client.set(k.reap(id), "1", { nx: true, px: Math.max(1, leaseUntil - now) }))) continue;
        await client.set(k.lease(id), String(leaseUntil));
        const c = await load(id);
        if (c) out.push(c);
        else await release(id);
      }
      return out;
    }),
    // ZREM / LREM decide atomically whether this caller removed it before a worker took it.
    cancel: g("cancel", async (id: string) => {
      const removed = (await client.zrem(k.delayed, id)) === 1 || (await client.lrem(k.ready, id)) > 0;
      if (removed) await client.del(k.job(id));
      return removed;
    }),
    nextRunAt: g("next", async (now: number) => {
      if ((await client.llen(k.ready)) > 0) return now;
      const [first] = await client.zrangebyscore(k.delayed, -Infinity, Infinity, 1);
      if (first === undefined) return undefined;
      return (await client.zscore(k.delayed, first)) ?? now;
    }),
    once: g("once", (key: string, ttlMs: number) => client.set(k.once(key), "1", { nx: true, px: ttlMs })),
    stats: g("stats", async () => ({
      pending: await client.llen(k.ready),
      delayed: await client.zcard(k.delayed),
      inflight: await client.llen(k.processing),
      deadLetters: await client.llen(k.dead),
    })),
    deadLetters: g("dead-letters", async () =>
      (await client.lrange(k.dead, 0, -1))
        .reverse()
        .map(parseDead)
        .filter((d): d is DeadLetter => d !== undefined),
    ),
    jobs: g("list", async (state: JobState, _now: number, offset: number, limit: number) => {
      let ids: string[];
      if (state === "delayed") ids = (await client.zrangebyscore(k.delayed, -Infinity, Infinity, offset + limit)).slice(offset);
      // ready and processing take new ids at the head, so the next one out is at the tail.
      else ids = (await client.lrange(state === "pending" ? k.ready : k.processing, -(offset + limit), -(offset + 1))).reverse();
      const out: JobRow[] = [];
      for (const id of ids) {
        const c = await load(id);
        if (!c) continue; // finished meanwhile
        const runAt = state === "delayed" ? await client.zscore(k.delayed, id) : null;
        out.push({ id, job: c.msg.job, input: c.msg.input, state, attempt: c.attempt, runAt });
      }
      return out;
    }),
    deadPage: g("dead-letters", async (offset: number, limit: number) => (await client.lrange(k.dead, offset, offset + limit - 1)).map(parseDead).filter((d): d is DeadLetter => d !== undefined)),
    // By id: the deadid:<id> index holds the letter's exact JSON, so LREM removes it wherever it
    // is in the list. Letters without an index entry (written by an older version, or whose entry
    // a concurrent take removed) are looked for among the newest DEAD_SCAN entries. LREM decides
    // which caller removed it.
    takeDead: g("dead-letter", async (id: string) => {
      const indexed = await client.get(k.deadId(id));
      if (indexed !== null) {
        const removed = (await client.lrem(k.dead, indexed)) > 0;
        await client.del(k.deadId(id));
        const d = removed ? parseDead(indexed) : undefined;
        if (d) return d;
      }
      for (let start = 0; start < DEAD_SCAN; start += 100) {
        const page = await client.lrange(k.dead, start, start + 99);
        for (const raw of page) {
          const d = parseDead(raw);
          if (d?.id === id) return (await client.lrem(k.dead, raw)) > 0 ? d : null;
        }
        if (page.length < 100) break;
      }
      return null;
    }),
    close: () => client.close?.(),
    inspect: () => ({ prefix, ...(client.inspect ? { client: client.inspect() } : {}) }),
  };
}

/**
 * Redis-backed jobs shared by every instance of the app: they survive restarts, any instance's
 * workers can run them, delays and retries wait in a sorted set, and a job whose worker dies is
 * rerun after `visibilityTimeout`. Same retry, backoff and dead-letter rules as memoryQueue.
 * Jobs receive the process env, not the dispatching request's env.
 *
 * ```ts
 * import { bunRedis } from "@miujs/cache";
 * queue({ jobs, adapter: redisQueue(bunRedis(), { concurrency: 4 }) })
 * ```
 */
export function redisQueue(client: QueueRedisLike, opts: RedisQueueOptions = {}): DurableQueue {
  const c = client as unknown as Record<string, unknown> | null;
  const missing = typeof c === "object" && c !== null ? METHODS.filter((m) => typeof c[m] !== "function") : [...METHODS];
  if (missing.length) {
    throw queueErrors.config(
      `redisQueue needs a Redis client; this one lacks ${missing.join(", ")}`,
      "Pass bunRedis() from @miujs/cache on Bun, or wrap another client with redisFromCommand(...) from @miujs/cache.",
    );
  }
  const prefix = opts.prefix ?? "miu:queue:";
  if (typeof prefix !== "string") throw queueErrors.config(`redisQueue prefix must be a string, got ${String(prefix)}`, 'Pass a prefix such as "myapp:queue:".');
  return durableQueue("redis", redisBackend(client, prefix), opts);
}
