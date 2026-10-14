import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  createQueue,
  memoryQueueDriver,
  sqliteQueueDriver,
  type QueueDriver,
} from "../../src/batteries/queue/index.ts";
import { redisQueueDriver } from "../../src/batteries/queue/redis.ts";
import { testRedis } from "./redis-server.ts";
import { ValidationError } from "../../src/core/errors.ts";
import { t } from "../../src/core/schema.ts";

const tmpFiles: string[] = [];
const tmpPath = () => {
  const p = `/tmp/miu-queue-${crypto.randomUUID()}.sqlite`;
  tmpFiles.push(p);
  return p;
};
afterAll(() => {
  for (const p of tmpFiles) for (const s of ["", "-wal", "-shm"]) rmSync(p + s, { force: true });
});

const redis = await testRedis();
const drivers: [string, () => QueueDriver][] = [
  ["memory", () => memoryQueueDriver()],
  ["sqlite", () => sqliteQueueDriver({ path: ":memory:" })],
  // Real redis-server (started by the helper, or REDIS_URL); skipped when unavailable.
  ...(redis ? [["redis", () => redisQueueDriver(redis.client, { prefix: redis.prefix() })] as [string, () => QueueDriver]] : []),
];

const job = (id: string, runAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: "x",
  payload: { id },
  status: "pending" as const,
  attempts: 0,
  runAt,
  createdAt: runAt,
  ...extra,
});

for (const [name, makeDriver] of drivers) {
  describe(`Queue: ${name}`, () => {
    const setup = () => {
      let now = 1_000_000;
      const clock = { advance: (ms: number) => (now += ms), get now() { return now; } };
      const driver = makeDriver();
      const queue = createQueue({ driver, now: () => now });
      return { queue, driver, clock };
    };

    test("a stale worker cannot complete or fail a job another worker reclaimed", async () => {
      const { driver, clock } = setup();
      await driver.push(job("j1", clock.now));
      const first = (await driver.claim(clock.now, 1_000))!;
      clock.advance(2_000); // lock expires
      const second = (await driver.claim(clock.now, 1_000))!;
      expect(second.attempts).toBe(first.attempts + 1);
      expect(await driver.complete("j1", clock.now, first.attempts)).toBe(false);
      expect(await driver.fail("j1", "late", null, clock.now, first.attempts)).toBe(false);
      expect((await driver.get("j1"))?.status).toBe("running");
      expect(await driver.complete("j1", clock.now, second.attempts)).toBe(true);
      expect((await driver.get("j1"))?.status).toBe("completed");
    });

    test("runOnce stops after `max` claims so zero-backoff retries cannot loop forever", async () => {
      const { queue } = setup();
      let runs = 0;
      const flaky = queue.define("flaky", {
        handler: async () => {
          runs++;
          throw new Error("always");
        },
        retries: 1_000_000,
        backoff: () => 0,
      });
      await flaky.dispatch({});
      const r = await queue.runOnce({ max: 25 });
      expect(runs).toBe(25);
      expect(r.processed).toBe(25);
    });

    test("definition(name) exposes schema, retries and backoff for external consumers", async () => {
      const { queue } = setup();
      const schema = t.object({ a: t.integer() });
      queue.define("d", { schema, handler: async () => {}, retries: 7 });
      const def = queue.definition("d")!;
      expect(def.retries).toBe(7);
      expect(def.schema).toBe(schema);
      expect(def.backoff(3)).toBe(4_000);
      expect(queue.definition("missing")).toBeUndefined();
    });

    test("dispatch + runOnce completes a job", async () => {
      const { queue } = setup();
      const seen: unknown[] = [];
      const greet = queue.define("greet", {
        schema: t.object({ name: t.string() }),
        handler: async (payload, j) => {
          const n: string = payload.name;
          seen.push([n, j.attempts]);
        },
      });
      const id = await greet.dispatch({ name: "miu" });
      expect(typeof id).toBe("string");
      expect((await queue.get(id))?.status).toBe("pending");
      expect(await queue.runOnce()).toEqual({ processed: 1, failed: 0 });
      expect(seen).toEqual([["miu", 1]]);
      const rec = await queue.get(id);
      expect(rec?.status).toBe("completed");
      expect(rec?.payload).toEqual({ name: "miu" });
      expect(rec?.finishedAt).toBe(1_000_000);
      expect(await queue.runOnce()).toEqual({ processed: 0, failed: 0 });
    });

    test("dispatch by name", async () => {
      const { queue } = setup();
      let got: unknown;
      queue.define("by-name", { handler: (p) => void (got = p) });
      await queue.dispatch("by-name", { a: 1 });
      await queue.runOnce();
      expect(got).toEqual({ a: 1 });
    });

    test("validates payload at dispatch", async () => {
      const { queue } = setup();
      const send = queue.define("send-email", {
        schema: t.object({ to: t.string({ format: "email" }) }),
        handler: () => {},
      });
      await expect(send.dispatch({ to: "nope" })).rejects.toBeInstanceOf(ValidationError);
      await expect(queue.dispatch("send-email", { to: 1 })).rejects.toBeInstanceOf(ValidationError);
      expect(await queue.runOnce()).toEqual({ processed: 0, failed: 0 });
    });

    test("delay is respected", async () => {
      const { queue, clock } = setup();
      let runs = 0;
      const j = queue.define("later", { handler: () => void runs++ });
      const id = await j.dispatch({}, { delay: 60 });
      expect((await queue.get(id))?.runAt).toBe(clock.now + 60_000);
      await queue.runOnce();
      expect(runs).toBe(0);
      clock.advance(59_999);
      await queue.runOnce();
      expect(runs).toBe(0);
      clock.advance(1);
      await queue.runOnce();
      expect(runs).toBe(1);
    });

    test("retries with backoff, then fails permanently", async () => {
      const { queue, clock } = setup();
      const events: string[] = [];
      queue.on("failed", (e) => events.push(`failed:${e.job.attempts}`));
      queue.on("retry", (e) => events.push(`retry:${e.job.attempts}`));
      let runs = 0;
      const j = queue.define("flaky", {
        retries: 2,
        backoff: (attempt) => attempt * 1000,
        handler: () => {
          runs++;
          throw new Error(`boom ${runs}`);
        },
      });
      const id = await j.dispatch({});
      expect(await queue.runOnce()).toEqual({ processed: 1, failed: 1 });
      let rec = await queue.get(id);
      expect(rec).toMatchObject({ status: "pending", attempts: 1, lastError: "boom 1", runAt: clock.now + 1000 });

      clock.advance(999);
      expect(await queue.runOnce()).toEqual({ processed: 0, failed: 0 });
      clock.advance(1);
      await queue.runOnce();
      rec = await queue.get(id);
      expect(rec).toMatchObject({ status: "pending", attempts: 2, lastError: "boom 2", runAt: clock.now + 2000 });

      clock.advance(2000);
      await queue.runOnce();
      rec = await queue.get(id);
      expect(rec).toMatchObject({ status: "failed", attempts: 3, lastError: "boom 3", finishedAt: clock.now });
      expect(runs).toBe(3);
      expect(events).toEqual(["retry:1", "retry:2", "failed:3"]);

      clock.advance(1_000_000);
      await queue.runOnce();
      expect(runs).toBe(3);

      const failed = await queue.failed();
      expect(failed.map((f) => f.id)).toEqual([id]);
      expect(failed[0]).toMatchObject({ name: "flaky", payload: {}, attempts: 3, lastError: "boom 3" });
    });

    test("default backoff is exponential", async () => {
      const { queue, clock } = setup();
      const j = queue.define("exp", { handler: () => { throw new Error("x"); } });
      const id = await j.dispatch({});
      await queue.runOnce();
      expect((await queue.get(id))?.runAt).toBe(clock.now + 1000);
      clock.advance(1000);
      await queue.runOnce();
      expect((await queue.get(id))?.runAt).toBe(clock.now + 2000);
    });

    test("retry(id) moves a failed job back to pending", async () => {
      const { queue } = setup();
      let ok = false;
      const j = queue.define("fix", {
        retries: 0,
        handler: () => {
          if (!ok) throw new Error("not yet");
        },
      });
      const id = await j.dispatch({});
      await queue.runOnce();
      expect((await queue.get(id))?.status).toBe("failed");
      expect(await queue.retry(id)).toBe(true);
      expect((await queue.get(id))?.status).toBe("pending");
      expect(await queue.failed()).toEqual([]);
      ok = true;
      await queue.runOnce();
      expect((await queue.get(id))?.status).toBe("completed");
      expect(await queue.retry(id)).toBe(false);
      expect(await queue.retry("missing")).toBe(false);
    });

    test("dedupe key returns the pending job instead of a duplicate", async () => {
      const { queue } = setup();
      let runs = 0;
      const j = queue.define("welcome", { handler: () => void runs++ });
      const a = await j.dispatch({ n: 1 }, { key: "welcome:42" });
      const b = await j.dispatch({ n: 2 }, { key: "welcome:42" });
      const c = await j.dispatch({ n: 3 }, { key: "welcome:43" });
      expect(b).toBe(a);
      expect(c).not.toBe(a);
      expect((await queue.get(a))?.key).toBe("welcome:42");
      expect(await queue.runOnce()).toEqual({ processed: 2, failed: 0 });
      expect(runs).toBe(2);
      // once completed, the key is free again
      const d = await j.dispatch({ n: 4 }, { key: "welcome:42" });
      expect(d).not.toBe(a);
    });

    test('dedupe "active" also matches a running job; the default only matches pending ones', async () => {
      const { queue, driver, clock } = setup();
      queue.define("sync", { handler: () => {} });
      const a = await queue.dispatch("sync", { n: 1 }, { key: "sync:1" });
      const claimed = (await driver.claim(clock.now, 60_000))!;
      expect(claimed.id).toBe(a);
      // running: "active" returns it…
      expect(await queue.dispatch("sync", { n: 2 }, { key: "sync:1", dedupe: "active" })).toBe(a);
      expect((await driver.list()).length).toBe(1);
      // …the default ("pending") enqueues a follow-up run
      const b = await queue.dispatch("sync", { n: 3 }, { key: "sync:1" });
      expect(b).not.toBe(a);
      // with both a running and a pending job, "active" returns one of them without adding more
      expect([a, b]).toContain(await queue.dispatch("sync", { n: 4 }, { key: "sync:1", dedupe: "active" }));
      expect((await driver.list()).length).toBe(2);
      // once neither is pending or running, the key is free again
      await driver.complete(a, clock.now, claimed.attempts);
      await queue.runOnce();
      const c = await queue.dispatch("sync", { n: 5 }, { key: "sync:1", dedupe: "active" });
      expect([a, b]).not.toContain(c);
    });

    test('dedupe "active" matches a job waiting to retry, and never a failed one', async () => {
      const { queue, clock } = setup();
      queue.define("flaky", { retries: 1, backoff: () => 1000, handler: () => { throw new Error("x"); } });
      const a = await queue.dispatch("flaky", {}, { key: "f" });
      await queue.runOnce(); // attempt 1 fails → pending again
      expect(await queue.dispatch("flaky", {}, { key: "f", dedupe: "active" })).toBe(a);
      clock.advance(1000);
      await queue.runOnce(); // attempt 2 fails → failed
      expect((await queue.get(a))?.status).toBe("failed");
      expect(await queue.dispatch("flaky", {}, { key: "f", dedupe: "active" })).not.toBe(a);
    });

    test("timeout counts as a failure", async () => {
      const { queue } = setup();
      let aborted = false;
      const j = queue.define("slow", {
        timeout: 20,
        retries: 0,
        handler: (_p, job) =>
          new Promise<void>((resolve) => {
            job.signal.addEventListener("abort", () => (aborted = true));
            setTimeout(resolve, 2000);
          }),
      });
      const id = await j.dispatch({});
      expect(await queue.runOnce()).toEqual({ processed: 1, failed: 1 });
      const rec = await queue.get(id);
      expect(rec?.status).toBe("failed");
      expect(rec?.lastError).toMatch(/timed out/i);
      expect(aborted).toBe(true);
    });

    test("unknown job name fails with a clear error", async () => {
      const { queue } = setup();
      const id = await queue.dispatch("ghost", {});
      expect(await queue.runOnce()).toEqual({ processed: 1, failed: 1 });
      const rec = await queue.get(id);
      expect(rec?.status).toBe("failed");
      expect(rec?.lastError).toMatch(/no handler.*ghost/i);
    });

    test("claim never returns the same job twice", async () => {
      const { driver } = setup();
      for (let i = 0; i < 10; i++) await driver.push(job(`j${i}`, 100 + i));
      const claims = await Promise.all(Array.from({ length: 12 }, () => driver.claim(1000, 60_000)));
      const ids = claims.filter((c) => c !== undefined).map((c) => c.id);
      expect(ids.length).toBe(10);
      expect(new Set(ids).size).toBe(10);
      expect(claims.filter((c) => c === undefined).length).toBe(2);
      expect(claims[0]).toMatchObject({ id: "j0", status: "running", attempts: 1 });
    });

    test("stale lock is reclaimed", async () => {
      const { driver } = setup();
      await driver.push(job("a", 0));
      expect((await driver.claim(1000, 500))?.id).toBe("a");
      expect(await driver.claim(1499, 500)).toBeUndefined();
      const again = await driver.claim(1500, 500);
      expect(again).toMatchObject({ id: "a", attempts: 2 });
    });

    test("list filters by status", async () => {
      const { driver } = setup();
      await driver.push(job("a", 0));
      await driver.push(job("b", 0));
      await driver.claim(10, 100);
      expect((await driver.list({ status: "pending" })).map((j) => j.id)).toEqual(["b"]);
      expect((await driver.list({ status: "running" })).map((j) => j.id)).toEqual(["a"]);
      expect((await driver.list()).length).toBe(2);
    });

    test("work() processes jobs and stops on abort", async () => {
      const queue = createQueue({ driver: makeDriver() });
      const done: number[] = [];
      const j = queue.define("w", { handler: (p: { n: number }) => void done.push(p.n) });
      for (let n = 0; n < 5; n++) await j.dispatch({ n });
      const ac = new AbortController();
      const stopped = queue.work({ concurrency: 2, pollInterval: 5, signal: ac.signal });
      const until = async (cond: () => boolean) => {
        for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
      };
      await until(() => done.length === 5);
      expect(done.sort()).toEqual([0, 1, 2, 3, 4]);
      await j.dispatch({ n: 5 });
      await until(() => done.length === 6);
      expect(done.length).toBe(6);
      ac.abort();
      await stopped;
      await j.dispatch({ n: 6 });
      await new Promise((r) => setTimeout(r, 30));
      expect(done.length).toBe(6);
    });

    test("prune deletes old completed jobs", async () => {
      const { queue, clock } = setup();
      const j = queue.define("p", { handler: () => {} });
      const old = await j.dispatch({});
      await queue.runOnce();
      clock.advance(10_000);
      const recent = await j.dispatch({});
      await queue.runOnce();
      const pending = await j.dispatch({}, { delay: 100 });
      expect(await queue.prune(5_000)).toBe(1);
      expect(await queue.get(old)).toBeUndefined();
      expect((await queue.get(recent))?.status).toBe("completed");
      expect((await queue.get(pending))?.status).toBe("pending");
    });

    test("onEvent option receives completed events", async () => {
      const events: string[] = [];
      const queue = createQueue({
        driver: makeDriver(),
        onEvent: (e) => events.push(`${e.type}:${e.job.name}`),
      });
      queue.define("e", { handler: () => {} });
      await queue.dispatch("e", {});
      await queue.runOnce();
      expect(events).toEqual(["completed:e"]);
    });
  });
}

describe("sqliteQueueDriver", () => {
  test("rejects invalid table names", () => {
    expect(() => sqliteQueueDriver({ path: ":memory:", table: "jobs; drop" })).toThrow(/table/i);
  });

  test("two drivers on the same file never claim the same job", async () => {
    const path = tmpPath();
    const a = sqliteQueueDriver({ path });
    const b = sqliteQueueDriver({ path });
    for (let i = 0; i < 20; i++) await a.push(job(`j${i}`, i));
    const claims = await Promise.all(
      Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).claim(1000, 60_000)),
    );
    const ids = claims.filter((c) => c !== undefined).map((c) => c.id);
    expect(ids.length).toBe(20);
    expect(new Set(ids).size).toBe(20);
    await a.close();
    await b.close();
  });

  test("jobs persist across driver instances", async () => {
    const path = tmpPath();
    const a = sqliteQueueDriver({ path, table: "my_jobs" });
    await a.push(job("keep", 5, { key: "k1" }));
    await a.close();
    const b = sqliteQueueDriver({ path, table: "my_jobs" });
    expect(await b.get("keep")).toMatchObject({ id: "keep", payload: { id: "keep" }, key: "k1", runAt: 5 });
    expect((await b.findPendingByKey("k1"))?.id).toBe("keep");
    await b.close();
  });
});
