// Behavior every in-process-worker queue adapter must share (memory, redis, sqlite).
// Each adapter's test file calls `queueSuite(...)` with a factory.
import { describe, expect, test } from "bun:test";
import { miu, route, t } from "miujs";
import { defineJob, manualClock, queue, schedule, type DeadLetter, type JobContext, type ManualClock, type QueueAdapter } from "../src/index.ts";

export const silent = { logLevel: "silent" as const };

export interface SuiteQueue {
  adapter: QueueAdapter;
  drain(): Promise<void>;
  deadLetters(): Promise<DeadLetter[]>;
}

export type MakeQueue = (o: { clock: ManualClock; concurrency?: number }) => SuiteQueue | Promise<SuiteQueue>;

/** Attach to a silent app so expected job failures don't spam the test output. */
export async function started<Q extends ReturnType<typeof queue>>(q: Q): Promise<Q> {
  await miu({ plugins: [q], ...silent }).ready();
  return q;
}

export function queueSuite(name: string, make: MakeQueue) {
  async function setup(opts: { concurrency?: number } = {}) {
    const clock = manualClock(Date.UTC(2026, 0, 1, 0, 0, 30));
    const sq = await make({ clock, concurrency: opts.concurrency });
    return { clock, mq: sq.adapter, sq };
  }

  describe(`${name}: dispatch and run`, () => {
    test("ctx.queue.dispatch runs the job with validated input", async () => {
      const { mq, sq } = await setup();
      const seen: JobContext<any>[] = [];
      const job = defineJob("greet", {
        input: t.object({ to: t.string(), n: t.default(t.number(), 1) }),
        run: (ctx) => void seen.push(ctx),
      });
      const r = route.post("/send", {
        handler: async ({ queue }) => {
          const { id } = await queue.dispatch(job, { to: "ann" } as any);
          return { id, ranDuringDispatch: seen.length };
        },
      });
      const app = miu({ routes: [r], plugins: [queue({ jobs: [job], adapter: mq })], ...silent });
      const res = await app.call(r);
      expect(res.status).toBe(200);
      expect(typeof res.body.id).toBe("string");
      expect(res.body.ranDuringDispatch).toBe(0); // runs in the background, not inside dispatch
      await sq.drain();
      expect(seen.length).toBe(1);
      expect(seen[0].input).toEqual({ to: "ann", n: 1 });
      expect(seen[0].attempt).toBe(1);
      expect(seen[0].maxAttempts).toBe(4);
      expect(seen[0].job).toBe("greet");
      expect(seen[0].id).toBe(res.body.id);
      expect(typeof seen[0].log.info).toBe("function");
      expect(seen[0].env).toBeDefined();
    });

    test("bad input is rejected at dispatch with MIU_E_VALIDATION", async () => {
      const { mq, sq } = await setup();
      let ran = false;
      const job = defineJob("j", { input: t.object({ n: t.number() }), run: () => void (ran = true) });
      const r = route.post("/send", { handler: async ({ queue }) => await queue.dispatch(job, { n: "nope" } as any) });
      const app = miu({ routes: [r], plugins: [queue({ jobs: [job], adapter: mq })], ...silent });
      const res = await app.call(r);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("MIU_E_VALIDATION");
      expect(res.body.error.message).toContain('job "j"');
      await sq.drain();
      expect(ran).toBe(false);
    });

    test("dispatching an unregistered job throws MIU_E_QUEUE_UNKNOWN_JOB", async () => {
      const { mq } = await setup();
      const known = defineJob("known", { input: t.object({}), run: () => {} });
      const other = defineJob("other", { input: t.object({}), run: () => {} });
      const q = queue({ jobs: [known], adapter: mq });
      await expect(q.dispatch(other, {})).rejects.toMatchObject({ code: "MIU_E_QUEUE_UNKNOWN_JOB" });
    });

    test("a negative or non-numeric delay throws MIU_E_QUEUE_DELAY", async () => {
      const { mq } = await setup();
      const job = defineJob("j", { input: t.object({}), run: () => {} });
      const q = await started(queue({ jobs: [job], adapter: mq }));
      await expect(q.dispatch(job, {}, { delay: -1 })).rejects.toMatchObject({ code: "MIU_E_QUEUE_DELAY" });
      await expect(q.dispatch(job, {}, { delay: Number.NaN })).rejects.toMatchObject({ code: "MIU_E_QUEUE_DELAY" });
      q.stop();
    });

    test("delay holds the job until the clock reaches it", async () => {
      const { clock, mq, sq } = await setup();
      const ranAt: number[] = [];
      const job = defineJob("j", { input: t.object({}), run: () => void ranAt.push(clock.now()) });
      const q = await started(queue({ jobs: [job], adapter: mq }));
      const start = clock.now();
      await q.dispatch(job, {}, { delay: 30 });
      await Promise.resolve();
      clock.advance(29_000);
      await new Promise((r) => setTimeout(r, 5));
      expect(ranAt).toEqual([]);
      await sq.drain(); // skips ahead on a manual clock
      expect(ranAt).toEqual([start + 30_000]);
      q.stop();
    });

    test("jobs can dispatch other jobs", async () => {
      const { mq, sq } = await setup();
      const log: string[] = [];
      const second = defineJob("second", { input: t.object({ from: t.string() }), run: ({ input }) => void log.push(`second from ${input.from}`) });
      const first = defineJob("first", {
        input: t.object({}),
        run: async ({ dispatch }) => {
          log.push("first");
          await dispatch(second, { from: "first" });
        },
      });
      const q = await started(queue({ jobs: [first, second], adapter: mq }));
      await q.dispatch(first, {});
      await sq.drain();
      expect(log).toEqual(["first", "second from first"]);
      q.stop();
    });

    test("concurrency limits parallel runs", async () => {
      const { mq, sq } = await setup({ concurrency: 2 });
      let active = 0;
      let peak = 0;
      const job = defineJob("slow", {
        input: t.object({}),
        run: async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        },
      });
      const q = await started(queue({ jobs: [job], adapter: mq }));
      for (let i = 0; i < 6; i++) await q.dispatch(job, {});
      await sq.drain();
      expect(peak).toBe(2);
      q.stop();
    });

    test("drain resolves immediately when idle", async () => {
      const { mq, sq } = await setup();
      queue({ jobs: [], adapter: mq });
      await sq.drain();
    });
  });

  describe(`${name}: retries and dead letters`, () => {
    test("retries with exponential backoff, then succeeds", async () => {
      const { clock, mq, sq } = await setup();
      const attempts: { attempt: number; at: number }[] = [];
      const job = defineJob("flaky", {
        input: t.object({}),
        run: ({ attempt }) => {
          attempts.push({ attempt, at: clock.now() });
          if (attempt < 3) throw new Error("not yet");
        },
      });
      const q = await started(queue({ jobs: [job], adapter: mq }));
      const t0 = clock.now();
      await q.dispatch(job, {});
      await sq.drain();
      expect(attempts).toEqual([
        { attempt: 1, at: t0 },
        { attempt: 2, at: t0 + 5_000 },
        { attempt: 3, at: t0 + 15_000 },
      ]);
      expect(await sq.deadLetters()).toEqual([]);
      q.stop();
    });

    test("fixed backoff in seconds", async () => {
      const { clock, mq, sq } = await setup();
      const at: number[] = [];
      const job = defineJob("fixed", {
        input: t.object({}),
        retries: 2,
        backoff: 2,
        run: () => {
          at.push(clock.now());
          throw new Error("always");
        },
      });
      const q = await started(queue({ jobs: [job], adapter: mq }));
      await q.dispatch(job, {});
      await sq.drain();
      expect(at.map((x) => x - at[0])).toEqual([0, 2_000, 4_000]);
      q.stop();
    });

    test("after retries are exhausted the message goes to the dead-letter list", async () => {
      const { mq, sq } = await setup();
      let calls = 0;
      const job = defineJob("doomed", {
        input: t.object({ n: t.number() }),
        retries: 2,
        run: () => {
          calls++;
          throw new Error("kaboom");
        },
      });
      const q = await started(queue({ jobs: [job], adapter: mq }));
      const { id } = await q.dispatch(job, { n: 1 });
      await sq.drain();
      expect(calls).toBe(3);
      const dead = await sq.deadLetters();
      expect(dead.length).toBe(1);
      expect(dead[0]).toMatchObject({ id, job: "doomed", input: { n: 1 }, attempts: 3, error: "kaboom" });
      expect(typeof dead[0].failedAt).toBe("number");
      q.stop();
    });

    test("retries: 0 dead-letters after one attempt", async () => {
      const { mq, sq } = await setup();
      let calls = 0;
      const failing = defineJob("once-fail", {
        input: t.object({}),
        retries: 0,
        run: () => {
          calls++;
          throw new Error("x");
        },
      });
      const q = await started(queue({ jobs: [failing], adapter: mq }));
      await q.dispatch(failing, {});
      await sq.drain();
      expect(calls).toBe(1);
      expect((await sq.deadLetters()).length).toBe(1);
      q.stop();
    });

    test("input is validated again before run; invalid messages are dead-lettered without retry", async () => {
      const { mq, sq } = await setup();
      let calls = 0;
      const job = defineJob("strict", { input: t.object({ n: t.number() }), run: () => void calls++ });
      const q = await started(queue({ jobs: [job], adapter: mq }));
      await mq.send({ id: "m1", job: "strict", input: { n: "bad" } }, {}, {});
      await mq.send({ id: "m2", job: "ghost", input: {} }, {}, {});
      await sq.drain();
      expect(calls).toBe(0);
      expect((await sq.deadLetters()).map((d) => [d.id, d.attempts, d.code])).toEqual([
        ["m1", 1, "MIU_E_VALIDATION"],
        ["m2", 1, "MIU_E_QUEUE_UNKNOWN_JOB"],
      ]);
      q.stop();
    });
  });

  describe(`${name}: schedules`, () => {
    test("runs schedules whose cron matches each minute, until stop()", async () => {
      const { clock, mq, sq } = await setup(); // starts at 00:00:30 UTC
      const ran: string[] = [];
      const tick = defineJob("tick", {
        input: t.object({ label: t.string() }),
        run: ({ input }) => void ran.push(`${input.label}@${new Date(clock.now()).toISOString().slice(11, 16)}`),
      });
      const q = queue({ jobs: [tick], schedules: [schedule("*/2 * * * *", tick, { label: "even" })], adapter: mq });
      const app = miu({ plugins: [q], ...silent });
      await app.ready();
      for (let i = 0; i < 5; i++) {
        clock.advance(60_000); // to 00:05:30, one minute at a time
        await sq.drain();
      }
      expect(ran).toEqual(["even@00:02", "even@00:04"]);
      q.stop();
      expect(clock.pending()).toBe(0);
      clock.advance(10 * 60_000);
      await sq.drain();
      expect(ran.length).toBe(2);
    });

    test("schedules for jobs not in `jobs` are registered automatically", async () => {
      const { clock, mq, sq } = await setup();
      let n = 0;
      const job = defineJob("auto", { input: t.object({}), run: () => void n++ });
      const q = queue({ schedules: [schedule("* * * * *", job)], adapter: mq });
      const app = miu({ plugins: [q], ...silent });
      await app.ready();
      clock.advance(60_000);
      await sq.drain();
      expect(n).toBe(1);
      q.stop();
    });
  });
}
