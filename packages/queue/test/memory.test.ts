import { describe, expect, test } from "bun:test";
import { miu, t } from "miujs";
import { defineJob, memoryQueue, queue, schedule } from "../src/index.ts";
import { queueSuite, silent } from "./queue-suite.ts";

queueSuite("memory queue", ({ clock, concurrency }) => {
  const mq = memoryQueue({ clock, concurrency });
  return { adapter: mq, drain: () => mq.drain(), deadLetters: async () => mq.deadLetters };
});

describe("queue() plugin", () => {
  test("rejects duplicate job names", () => {
    const a = defineJob("same", { input: t.object({}), run: () => {} });
    const b = defineJob("same", { input: t.object({}), run: () => {} });
    expect(() => queue({ jobs: [a, b], adapter: memoryQueue() })).toThrow(expect.objectContaining({ code: "MIU_E_QUEUE_JOB_DUPLICATE" }) as any);
  });

  test("an adapter can only serve one queue()", () => {
    const mq = memoryQueue();
    queue({ jobs: [], adapter: mq });
    expect(() => queue({ jobs: [], adapter: mq })).toThrow(expect.objectContaining({ code: "MIU_E_QUEUE_CONFIG" }) as any);
  });

  test("defaults to the memory adapter off Workers", () => {
    expect((queue({ jobs: [] }).inspect() as any).adapter).toBe("memory");
  });

  test("inspect lists the adapter, jobs and schedules", async () => {
    const job = defineJob("report", { input: t.object({ day: t.string() }), retries: 1, backoff: 10, run: () => {} });
    const mq = memoryQueue({ concurrency: 3 });
    const q = queue({ jobs: [job], schedules: [schedule("0 6 * * *", job, { day: "today" })], adapter: mq });
    const app = miu({ plugins: [q], ...silent });
    await app.ready();
    const info = app.inspect().plugins.find((p) => p.name === "queue")!.info as any;
    q.stop();
    expect(info.adapter).toBe("memory");
    expect(info.concurrency).toBe(3);
    expect(info.jobs).toEqual([{ name: "report", retries: 1, backoff: 10, input: job.input.json }]);
    expect(info.schedules).toEqual([{ cron: "0 6 * * *", job: "report", input: { day: "today" } }]);
    expect(info).toMatchObject({ pending: 0, running: 0, delayed: 0, deadLetters: 0 });
  });

  test("cloudflare() needs nothing for the memory adapter", () => {
    expect(queue({ jobs: [], adapter: memoryQueue() }).cloudflare!()).toEqual({});
  });
});

describe("memory queue long delays", () => {
  test("a delay longer than a timer can hold (24.8 days) does not run the job right away", async () => {
    const ran: string[] = [];
    const job = defineJob("later", { input: t.object({}), run: () => void ran.push("ran") });
    const mq = memoryQueue();
    const q = queue({ jobs: [job], adapter: mq });
    const app = miu({ plugins: [q], ...silent });
    await app.ready();
    await q.dispatch(job, {}, { delay: 30 * 86_400 }); // 30 days
    await new Promise((r) => setTimeout(r, 60));
    q.stop();
    expect(ran).toEqual([]);
  });

  test("numeric backoff past the timer limit does not retry immediately", async () => {
    let attempts = 0;
    const job = defineJob("flaky", { input: t.object({}), retries: 1, backoff: 40 * 86_400, run: () => { attempts++; throw new Error("boom"); } });
    const mq = memoryQueue();
    const q = queue({ jobs: [job], adapter: mq });
    const app = miu({ plugins: [q], ...silent });
    await app.ready();
    await q.dispatch(job, {});
    await new Promise((r) => setTimeout(r, 80));
    q.stop();
    expect(attempts).toBe(1);
  });
});

describe("memory queue shutdown", () => {
  test("after app.close() no queued job starts (they ran against closed databases before)", async () => {
    const ran: number[] = [];
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = defineJob("slow", {
      input: t.object({ n: t.integer() }),
      retries: 0,
      run: async ({ input }) => {
        ran.push(input.n);
        if (input.n === 0) {
          await gate;
          await new Promise((r) => setTimeout(r, 10));
          finished = true;
        }
      },
    });
    const q = queue({ jobs: [job], adapter: memoryQueue({ concurrency: 1 }) });
    const app = miu({ plugins: [q], ...silent });
    await app.ready();
    for (let n = 0; n < 5; n++) await q.dispatch(job, { n });
    while (ran.length === 0) await new Promise((r) => setTimeout(r, 1));
    const closing = app.close();
    release();
    await closing;
    // close() waits for the job that was running (it may still use the database).
    expect(finished).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual([0]);
    await q.dispatch(job, { n: 9 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual([0]);
  });
});
