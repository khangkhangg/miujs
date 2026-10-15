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
