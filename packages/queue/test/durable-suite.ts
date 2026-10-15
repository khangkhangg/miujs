// Extra behavior for queues whose jobs live outside the process (redis, sqlite): restarts,
// visibility timeouts, several workers on one store. Each adapter's test file calls it.
import { describe, expect, test } from "bun:test";
import { t } from "miujs";
import { defineJob, manualClock, queue, schedule, type DurableQueue, type ManualClock } from "../src/index.ts";
import { started } from "./queue-suite.ts";

/** Opens a queue over `storage`; two opens on the same storage are two app instances. */
export type OpenDurable<S> = (storage: S, o: { clock: ManualClock; concurrency?: number; visibilityTimeout?: number }) => DurableQueue;

const settle = () => new Promise((r) => setTimeout(r, 5));

export function durableSuite<S>(name: string, makeStorage: () => S, open: OpenDurable<S>) {
  const fresh = () => ({ clock: manualClock(Date.UTC(2026, 0, 1, 0, 0, 30)), storage: makeStorage() });

  describe(`${name}: durability`, () => {
    test("a job dispatched before a restart runs after it", async () => {
      const { clock, storage } = fresh();
      const seen: unknown[] = [];
      const job = defineJob("persist", { input: t.object({ n: t.number() }), run: ({ input }) => void seen.push(input) });
      const a = open(storage, { clock });
      const qa = queue({ jobs: [job], adapter: a }); // producer only: never set up, so it runs nothing
      await qa.dispatch(job, { n: 1 });
      await qa.dispatch(job, { n: 2 }, { delay: 60 });
      await settle();
      expect(seen).toEqual([]);
      expect(await a.stats()).toMatchObject({ pending: 1, delayed: 1, inflight: 0 });
      a.stop();
      a.close();

      const b = open(storage, { clock });
      const qb = await started(queue({ jobs: [job], adapter: b }));
      await b.drain();
      expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
      expect(await b.stats()).toEqual({ pending: 0, delayed: 0, inflight: 0, deadLetters: 0 });
      qb.stop();
      b.close();
    });

    test("dead letters survive a restart", async () => {
      const { clock, storage } = fresh();
      const job = defineJob("doomed", { input: t.object({}), retries: 0, run: () => Promise.reject(new Error("nope")) });
      const a = open(storage, { clock });
      const qa = await started(queue({ jobs: [job], adapter: a }));
      const { id } = await qa.dispatch(job, {});
      await a.drain();
      qa.stop();
      a.close();
      const b = open(storage, { clock });
      queue({ jobs: [job], adapter: b });
      expect(await b.listDeadLetters()).toMatchObject([{ id, job: "doomed", attempts: 1, error: "nope" }]);
      b.close();
    });
  });

  describe(`${name}: visibility timeout`, () => {
    test("a job whose worker died is redelivered after the timeout, as the next attempt", async () => {
      const { clock, storage } = fresh();
      let startedRun!: () => void;
      const running = new Promise<void>((r) => (startedRun = r));
      const hang = defineJob("work", { input: t.object({}), run: () => (startedRun(), new Promise(() => {})) });
      const a = open(storage, { clock, visibilityTimeout: 30 });
      const qa = await started(queue({ jobs: [hang], adapter: a }));
      const t0 = clock.now();
      await qa.dispatch(hang, {});
      await running;
      qa.stop(); // the worker "dies": no more lease renewals

      const runs: { attempt: number; at: number }[] = [];
      const work = defineJob("work", { input: t.object({}), run: ({ attempt }) => void runs.push({ attempt, at: clock.now() }) });
      const b = open(storage, { clock, visibilityTimeout: 30 });
      const qb = await started(queue({ jobs: [work], adapter: b }));
      clock.advance(29_000);
      await settle();
      await b.drain();
      expect(runs).toEqual([]); // lease still valid
      clock.advance(2_000);
      await settle();
      await b.drain();
      expect(runs.length).toBe(1);
      expect(runs[0].attempt).toBe(2);
      expect(runs[0].at - t0).toBeGreaterThanOrEqual(30_000);
      expect(await b.stats()).toMatchObject({ pending: 0, inflight: 0, delayed: 0 });
      qb.stop();
      b.close();
    });

    test("a timed-out job with no attempts left is dead-lettered with MIU_E_QUEUE_TIMEOUT", async () => {
      const { clock, storage } = fresh();
      let startedRun!: () => void;
      const running = new Promise<void>((r) => (startedRun = r));
      const job = defineJob("once", { input: t.object({}), retries: 0, run: () => (startedRun(), new Promise(() => {})) });
      const a = open(storage, { clock, visibilityTimeout: 10 });
      const qa = await started(queue({ jobs: [job], adapter: a }));
      await qa.dispatch(job, {});
      await running;
      qa.stop();
      const b = open(storage, { clock, visibilityTimeout: 10 });
      const qb = await started(queue({ jobs: [job], adapter: b }));
      clock.advance(11_000);
      await settle();
      await b.drain();
      expect(await b.listDeadLetters()).toMatchObject([{ job: "once", attempts: 1, code: "MIU_E_QUEUE_TIMEOUT" }]);
      qb.stop();
      b.close();
    });

    test("a long job keeps renewing its lease, so another worker never steals it", async () => {
      const { clock, storage } = fresh();
      let finish!: () => void;
      let startedRun!: () => void;
      const running = new Promise<void>((r) => (startedRun = r));
      const runs: number[] = [];
      const job = defineJob("long", {
        input: t.object({}),
        run: ({ attempt }) => {
          runs.push(attempt);
          startedRun();
          return new Promise<void>((r) => (finish = r));
        },
      });
      const a = open(storage, { clock, visibilityTimeout: 30 });
      const b = open(storage, { clock, visibilityTimeout: 30 });
      const qa = await started(queue({ jobs: [job], adapter: a }));
      await qa.dispatch(job, {});
      await running;
      const qb = await started(queue({ jobs: [job], adapter: b }));
      for (let i = 0; i < 8; i++) {
        clock.advance(5_000); // 40s in all, past one visibility timeout
        await settle();
      }
      expect(runs).toEqual([1]);
      finish();
      await a.drain();
      await b.drain();
      expect(runs).toEqual([1]);
      expect(await a.stats()).toEqual({ pending: 0, delayed: 0, inflight: 0, deadLetters: 0 });
      qa.stop();
      qb.stop();
      a.close();
      b.close();
    });
  });

  describe(`${name}: several instances`, () => {
    test("each job runs once even with two workers on one store", async () => {
      const { clock, storage } = fresh();
      const ran: number[] = [];
      const job = defineJob("n", { input: t.object({ i: t.number() }), run: async ({ input }) => void ran.push(input.i) });
      const a = open(storage, { clock, concurrency: 2 });
      const b = open(storage, { clock, concurrency: 2 });
      const qa = await started(queue({ jobs: [job], adapter: a }));
      const qb = await started(queue({ jobs: [job], adapter: b }));
      for (let i = 0; i < 10; i++) await qa.dispatch(job, { i });
      await Promise.all([a.drain(), b.drain()]);
      expect(ran.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      qa.stop();
      qb.stop();
      a.close();
      b.close();
    });

    test("a schedule fires once per minute across instances", async () => {
      const { clock, storage } = fresh();
      let n = 0;
      const job = defineJob("cron", { input: t.object({}), run: () => void n++ });
      const a = open(storage, { clock });
      const b = open(storage, { clock });
      const qa = await started(queue({ schedules: [schedule("* * * * *", job)], adapter: a }));
      const qb = await started(queue({ schedules: [schedule("* * * * *", job)], adapter: b }));
      clock.advance(60_000);
      await settle();
      await Promise.all([a.drain(), b.drain()]);
      expect(n).toBe(1);
      qa.stop();
      qb.stop();
      a.close();
      b.close();
    });
  });

  describe(`${name}: config and inspect`, () => {
    test("bad options are MIU_E_QUEUE_CONFIG with a fix", () => {
      const { clock, storage } = fresh();
      for (const o of [{ concurrency: 0 }, { visibilityTimeout: 0 }, { visibilityTimeout: Number.NaN }]) {
        try {
          open(storage, { clock, ...o });
          throw new Error("expected throw");
        } catch (e: any) {
          expect(e.code).toBe("MIU_E_QUEUE_CONFIG");
          expect(e.fix).toBeTruthy();
        }
      }
    });

    test("inspect shows settings; stats counts work", async () => {
      const { clock, storage } = fresh();
      const job = defineJob("x", { input: t.object({}), run: () => {} });
      const a = open(storage, { clock, concurrency: 3, visibilityTimeout: 45 });
      const q = queue({ jobs: [job], adapter: a });
      expect(a.inspect!()).toMatchObject({ concurrency: 3, visibilityTimeout: 45, running: 0 });
      expect((q.inspect() as any).adapter).toBe(a.name);
      await q.dispatch(job, {});
      expect(await a.stats()).toEqual({ pending: 1, delayed: 0, inflight: 0, deadLetters: 0 });
      a.close();
    });
  });
}
