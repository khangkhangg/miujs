// Memory and exit health of queues: thousands of jobs with retries and failures, stop()/close()
// really stopping workers, and idle queues (and a full app) letting the process exit.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { miu, t } from "miujs";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { defineJob, manualClock, memoryQueue, queue, schedule, sqliteQueue, type DurableQueue, type MemoryQueue } from "../src/index.ts";

const PKG = join(import.meta.dir, "..");
const report = (r: { name: string }) => process.env.LEAK_REPORT && console.log(describeLeak(r as never));

/** Every 3rd job fails once then succeeds; every 3rd+1 fails for good (one retry); the rest pass. */
const flaky = defineJob("flaky", {
  input: t.object({ i: t.integer(), payload: t.string() }),
  retries: 1,
  backoff: 5,
  run: ({ input, attempt }) => {
    if (input.i % 3 === 0 && attempt === 1) throw new Error("transient");
    if (input.i % 3 === 1) throw new Error(`permanent failure for job ${input.i}`);
  },
});

async function churn(name: string, adapter: MemoryQueue | DurableQueue) {
  const q = queue({ jobs: [flaky], adapter });
  await miu({ logLevel: "silent", plugins: [q] }).ready();
  const payload = "x".repeat(200);
  const r = await leakCheck(
    name,
    async (i) => {
      await q.dispatch(flaky, { i, payload });
      if (i % 10 === 9) await adapter.drain();
    },
    { perRound: 2000, rounds: 5, warmup: 2000 },
  );
  q.stop();
  return r;
}

describe("thousands of jobs with retries and failures plateau", () => {
  test("memory queue", async () => {
    const r = await churn("memory queue", memoryQueue({ clock: manualClock(0) }));
    report(r);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("memory queue keeps the newest maxDeadLetters", async () => {
    const mq = memoryQueue({ clock: manualClock(0), maxDeadLetters: 10 });
    const q = queue({ jobs: [flaky], adapter: mq });
    await miu({ logLevel: "silent", plugins: [q] }).ready();
    for (let i = 0; i < 300; i++) await q.dispatch(flaky, { i, payload: "" });
    await mq.drain();
    expect(mq.deadLetters.length).toBe(10);
    expect(mq.deadLetters.at(-1)!.input).toEqual({ i: 298, payload: "" });
    expect(mq.inspect!().deadLetters).toBe(10);
  });

  test("sqlite queue", async () => {
    const sq = sqliteQueue(new Database(":memory:"), { clock: manualClock(0) });
    const r = await churn("sqlite queue", sq);
    sq.close();
    report(r);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);
});

describe("durable queues stop when told", () => {
  test("a job finishing after stop() does not make the worker claim more", async () => {
    const db = new Database(":memory:");
    const sq = sqliteQueue(db, { pollInterval: 10 });
    const ran: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = defineJob("slow", {
      input: t.object({ n: t.integer() }),
      run: async ({ input }) => {
        ran.push(input.n);
        if (input.n === 1) await gate;
      },
    });
    const q = queue({ jobs: [job], adapter: sq });
    await miu({ logLevel: "silent", plugins: [q] }).ready();
    await q.dispatch(job, { n: 1 });
    await q.dispatch(job, { n: 2 });
    await q.dispatch(job, { n: 3 });
    while (!ran.length) await new Promise((r) => setTimeout(r, 5));
    sq.stop();
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(ran).toEqual([1]);
    expect((await sq.stats()).pending).toBe(2);
    sq.close();
  });

  test("close() does not let a finishing job reopen the database", async () => {
    let opens = 0;
    const db = new Database(":memory:");
    const counting = { query: (s: string) => db.query(s), exec: (s: string) => db.exec(s), close: () => {} };
    const sq = sqliteQueue(
      new Proxy(counting, { get: (o, k) => (k === "exec" ? (s: string) => (s.includes("CREATE TABLE") && opens++, db.exec(s)) : o[k as keyof typeof o]) }),
      { pollInterval: 10 },
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const job = defineJob("slow2", { input: t.object({}), run: async () => ((started = true), await gate) });
    const q = queue({ jobs: [job], adapter: sq });
    await miu({ logLevel: "silent", plugins: [q] }).ready();
    await q.dispatch(job, {});
    await q.dispatch(job, {});
    while (!started) await new Promise((r) => setTimeout(r, 5));
    sq.close();
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(opens).toBe(1);
  });
});

describe("idle queues let the process exit", () => {
  test("memory queue after jobs and retries", async () => {
    const r = await exitCheck(
      `
      import { miu, t } from "miujs";
      import { defineJob, memoryQueue, queue, schedule } from "../src/index.ts";
      const job = defineJob("j", { input: t.object({ i: t.integer() }), retries: 1, backoff: 0.01, run: ({ input, attempt }) => { if (input.i % 2 && attempt === 1) throw new Error("x"); } });
      const mq = memoryQueue();
      const q = queue({ jobs: [job], schedules: [schedule("* * * * *", job, { i: 0 })], adapter: mq });
      await miu({ logLevel: "silent", plugins: [q] }).ready();
      for (let i = 0; i < 50; i++) await q.dispatch(job, { i });
      await mq.drain();
      `,
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  });

  test("sqlite queue (file) after jobs, without stop()", async () => {
    const r = await exitCheck(
      `
      import { mkdtempSync } from "node:fs";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      import { miu, t } from "miujs";
      import { defineJob, sqliteQueue, queue, schedule } from "../src/index.ts";
      const job = defineJob("j", { input: t.object({ i: t.integer() }), run: () => {} });
      const sq = sqliteQueue(join(mkdtempSync(join(tmpdir(), "miu-q-")), "jobs.sqlite"), { pollInterval: 50 });
      const q = queue({ jobs: [job], schedules: [schedule("* * * * *", job, { i: 0 })], adapter: sq });
      await miu({ logLevel: "silent", plugins: [q] }).ready();
      for (let i = 0; i < 20; i++) await q.dispatch(job, { i });
      await sq.drain();
      `,
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  });

  test("an app with session + auth + cache + queues (memory and sqlite) + rateLimit exits after requests and jobs", async () => {
    const r = await exitCheck(
      `
      import { mkdtempSync } from "node:fs";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      import { miu, route, t } from "miujs";
      import { session, memorySessionStore } from "../../session/src/index.ts";
      import { auth, memoryUserStore } from "../../auth/src/index.ts";
      import { cache } from "../../cache/src/index.ts";
      import { rateLimit } from "../../ratelimit/src/index.ts";
      import { defineJob, memoryQueue, sqliteQueue, queue, schedule } from "../src/index.ts";
      const a = defineJob("a", { input: t.object({ i: t.integer() }), retries: 1, backoff: 0.01, run: ({ input, attempt }) => { if (input.i % 2 && attempt === 1) throw new Error("x"); } });
      const b = defineJob("b", { input: t.object({ i: t.integer() }), run: () => {} });
      const mq = memoryQueue();
      const sq = sqliteQueue(join(mkdtempSync(join(tmpdir(), "miu-q-")), "jobs.sqlite"), { pollInterval: 50 });
      const app = miu({
        logLevel: "silent",
        plugins: [
          session({ secret: "test-secret-that-is-long-enough-0123456789", store: memorySessionStore() }),
          auth({ users: memoryUserStore(), password: { algorithm: "pbkdf2", iterations: 1 } }),
          rateLimit({ rules: [{ match: { path: "/*" }, limit: 1000, window: "1m" }] }),
          cache(),
          queue({ jobs: [a], schedules: [schedule("* * * * *", a, { i: 0 })], adapter: mq }),
          queue({ jobs: [b], adapter: sq }),
        ],
        routes: [route.post("/work", { handler: async (ctx) => {
          ctx.session.set("n", 1);
          await ctx.cache.remember("k", 60, async () => 1);
          await ctx.cache.set("t", 1, { ttl: 60, tags: ["x"] });
          await ctx.queue.dispatch(a, { i: 1 });
          return "ok";
        } })],
      });
      await app.ready();
      const post = (p, body) => app.fetch(new Request("http://localhost" + p, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));
      await post("/auth/register", { email: "a@example.com", password: "correct horse battery" });
      await post("/auth/login", { email: "a@example.com", password: "wrong password!" });
      for (let i = 0; i < 20; i++) await post("/work", {});
      for (let i = 0; i < 10; i++) await app.plugins.find((p) => p.name === "queue" && p.adapter === sq).dispatch(b, { i });
      await mq.drain();
      await sq.drain();
      `,
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  });
});

describe("delayed messages", () => {
  test("a pending delay or retry backoff does not keep the process alive", async () => {
    const r = await exitCheck(
      `
      import { miu, t } from "miujs";
      import { defineJob, memoryQueue, queue } from "../src/index.ts";
      const job = defineJob("j", { input: t.object({ fail: t.boolean() }), retries: 3, backoff: 600, run: ({ input }) => { if (input.fail) throw new Error("x"); } });
      const mq = memoryQueue();
      const q = queue({ jobs: [job], adapter: mq });
      await miu({ logLevel: "silent", plugins: [q] }).ready();
      await q.dispatch(job, { fail: false }, { delay: 3600 });
      await q.dispatch(job, { fail: true });
      `,
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  });

  for (const [name, make] of [
    ["memory", () => memoryQueue({ clock: manualClock(0) })],
    ["sqlite", () => sqliteQueue(new Database(":memory:"), { clock: manualClock(0) })],
  ] as const) {
    test(`${name}: cancel() removes a delayed message before it runs`, async () => {
      const adapter = make();
      const ran: number[] = [];
      const job = defineJob("later", { input: t.object({ n: t.integer() }), run: ({ input }) => void ran.push(input.n) });
      const q = queue({ jobs: [job], adapter });
      await miu({ logLevel: "silent", plugins: [q] }).ready();
      const a = await q.dispatch(job, { n: 1 }, { delay: 60 });
      await q.dispatch(job, { n: 2 }, { delay: 60 });
      expect(await q.cancel(a.id)).toBe(true);
      expect(await q.cancel(a.id)).toBe(false);
      expect(await q.cancel("no-such-id")).toBe(false);
      await adapter.drain();
      expect(ran).toEqual([2]);
      if (name === "memory") expect((adapter as MemoryQueue).inspect!().delayed).toBe(0);
      q.stop();
    });
  }

  test("ctx.queue.cancel is available in handlers", async () => {
    const mq = memoryQueue({ clock: manualClock(0) });
    const job = defineJob("x", { input: t.object({}), run: () => {} });
    const q = queue({ jobs: [job], adapter: mq });
    const { route } = await import("miujs");
    const r = route.post("/d", {
      handler: async ({ queue: qc }) => {
        const { id } = await qc.dispatch(job, {}, { delay: 30 });
        return { cancelled: await qc.cancel(id) };
      },
    });
    const app = miu({ logLevel: "silent", plugins: [q], routes: [r] });
    expect((await app.call(r)).body).toEqual({ cancelled: true });
  });
});

describe("addSchedule / removeSchedule", () => {
  for (const [name, make] of [
    ["memory", (clock: ReturnType<typeof manualClock>) => memoryQueue({ clock })],
    ["sqlite", (clock: ReturnType<typeof manualClock>) => sqliteQueue(new Database(":memory:"), { clock, pollInterval: 3_600_000 })],
  ] as const) {
    test(`${name}: the minute scheduler starts with the first schedule and stops with the last`, async () => {
      const clock = manualClock(Date.UTC(2026, 0, 1, 0, 0, 30));
      const adapter = make(clock);
      const ran: string[] = [];
      const job = defineJob("tick", { input: t.object({ tag: t.string() }), run: ({ input }) => void ran.push(input.tag) });
      const q = queue({ jobs: [job], adapter });
      await miu({ logLevel: "silent", plugins: [q] }).ready();
      const base = clock.pending();
      clock.advance(120_000);
      await adapter.drain();
      expect(ran).toEqual([]);
      const s = q.addSchedule(schedule("* * * * *", job, { tag: "a" }));
      expect(clock.pending()).toBe(base + 1);
      clock.advance(60_000);
      await adapter.drain();
      expect(ran).toEqual(["a"]);
      expect(q.removeSchedule(s)).toBe(true);
      expect(q.removeSchedule(s)).toBe(false);
      expect(clock.pending()).toBe(base);
      clock.advance(180_000);
      await adapter.drain();
      expect(ran).toEqual(["a"]);
      q.stop();
    });
  }

  test("addSchedule registers the schedule's job and rejects a different job with the same name", () => {
    const q = queue({ adapter: memoryQueue({ clock: manualClock(0) }) });
    const job = defineJob("new-job", { input: t.object({}), run: () => {} });
    q.addSchedule(schedule("0 * * * *", job));
    expect(q.hasJob("new-job")).toBe(true);
    const clash = defineJob("new-job", { input: t.object({}), run: () => {} });
    expect(() => q.addSchedule(schedule("0 * * * *", clash))).toThrow();
  });
});
