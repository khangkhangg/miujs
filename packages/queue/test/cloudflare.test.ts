import { describe, expect, test } from "bun:test";
import { miu, route, t } from "miujs";
import { cloudflareQueue, defineJob, queue, schedule, type QueueMessage } from "../src/index.ts";

/** Fake of a Cloudflare Queue producer binding. */
function fakeQueue() {
  const sent: { body: unknown; options?: { delaySeconds?: number } }[] = [];
  return {
    sent,
    async send(body: unknown, options?: { delaySeconds?: number }) {
      sent.push({ body: structuredClone(body), options });
    },
    async sendBatch(messages: { body: unknown; delaySeconds?: number }[]) {
      for (const m of messages) sent.push({ body: structuredClone(m.body), options: { delaySeconds: m.delaySeconds } });
    },
  };
}

/** Fake of a Cloudflare MessageBatch delivered to a consumer. */
function fakeBatch(bodies: { body: unknown; attempts?: number }[], queueName = "jobs") {
  const outcome: Record<string, string> = {};
  const messages = bodies.map((b, i) => {
    const id = `msg-${i}`;
    return {
      id,
      timestamp: new Date(),
      body: b.body,
      attempts: b.attempts ?? 1,
      ack: () => void (outcome[id] = "ack"),
      retry: (o?: { delaySeconds?: number }) => void (outcome[id] = `retry:${o?.delaySeconds ?? "default"}`),
    };
  });
  return { batch: { queue: queueName, messages, ackAll() {}, retryAll() {} }, outcome };
}

const silent = { logLevel: "silent" as const };
const workerd = { runtime: "workerd" as const };
const msg = (job: string, input: unknown, id = "m"): QueueMessage => ({ id, job, input });

describe("cloudflareQueue: producing", () => {
  const job = defineJob("email", { input: t.object({ to: t.string() }), run: () => {} });
  const r = route.post("/send", {
    query: t.object({ delay: t.optional(t.number()) }),
    handler: async ({ queue, query }) => await queue.dispatch(job, { to: "a@b.c" }, { delay: query.delay }),
  });

  test("dispatch sends { id, job, input } to env[binding]", async () => {
    const JOBS = fakeQueue();
    const app = miu({ routes: [r], plugins: [queue({ jobs: [job], adapter: cloudflareQueue({ binding: "JOBS" }) })], ...silent });
    const res = await app.dispatch(new Request("http://x/send", { method: "POST" }), { JOBS }, workerd);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(JOBS.sent).toEqual([{ body: { id, job: "email", input: { to: "a@b.c" } }, options: undefined }]);
  });

  test("delay becomes delaySeconds", async () => {
    const JOBS = fakeQueue();
    const app = miu({ routes: [r], plugins: [queue({ jobs: [job], adapter: cloudflareQueue() })], ...silent });
    await app.dispatch(new Request("http://x/send?delay=90", { method: "POST" }), { JOBS }, workerd);
    expect(JOBS.sent[0].options).toEqual({ delaySeconds: 90 });
  });

  test("delays over 12h are rejected (Cloudflare's limit)", async () => {
    const JOBS = fakeQueue();
    const app = miu({ routes: [r], plugins: [queue({ jobs: [job], adapter: cloudflareQueue() })], ...silent });
    const res = await app.dispatch(new Request("http://x/send?delay=43201", { method: "POST" }), { JOBS }, workerd);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.code).toBe("MIU_E_QUEUE_DELAY");
    expect(JOBS.sent.length).toBe(0);
  });

  test("a missing binding fails with MIU_E_QUEUE_BINDING", async () => {
    const app = miu({ routes: [r], plugins: [queue({ jobs: [job], adapter: cloudflareQueue({ binding: "JOBS" }) })], ...silent });
    const res = await app.dispatch(new Request("http://x/send", { method: "POST" }), {}, workerd);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("MIU_E_QUEUE_BINDING");
    expect(body.error.fix).toContain("JOBS");
  });
});

describe("cloudflareQueue: consuming", () => {
  function make(run: (ctx: any) => unknown, extra: { retries?: number; backoff?: number | "exponential"; queue?: string } = {}) {
    const job = defineJob("work", { input: t.object({ n: t.number() }), retries: extra.retries, backoff: extra.backoff, run });
    const app = miu({ plugins: [queue({ jobs: [job], adapter: cloudflareQueue({ binding: "JOBS", queue: extra.queue }) })], ...silent });
    return { app, job };
  }

  test("runs the job and acks on success", async () => {
    const seen: any[] = [];
    const { app } = make((ctx) => void seen.push(ctx));
    const env = { JOBS: fakeQueue(), SECRET: "s" };
    const { batch, outcome } = fakeBatch([{ body: msg("work", { n: 1 }, "id-1"), attempts: 2 }]);
    await app.queue(batch, env, {});
    expect(outcome).toEqual({ "msg-0": "ack" });
    expect(seen[0].input).toEqual({ n: 1 });
    expect(seen[0].attempt).toBe(2);
    expect(seen[0].id).toBe("id-1");
    expect(seen[0].env).toBe(env);
  });

  test("on failure, retries with the job's backoff", async () => {
    const { app } = make(() => {
      throw new Error("nope");
    });
    const { batch, outcome } = fakeBatch([
      { body: msg("work", { n: 1 }), attempts: 1 },
      { body: msg("work", { n: 2 }), attempts: 3 },
    ]);
    await app.queue(batch, {}, {});
    expect(outcome).toEqual({ "msg-0": "retry:5", "msg-1": "retry:20" });
  });

  test("after the last attempt, acks (and logs) instead of retrying", async () => {
    const { app } = make(
      () => {
        throw new Error("nope");
      },
      { retries: 1, backoff: 30 },
    );
    const { batch, outcome } = fakeBatch([
      { body: msg("work", { n: 1 }), attempts: 1 },
      { body: msg("work", { n: 1 }), attempts: 2 },
    ]);
    await app.queue(batch, {}, {});
    expect(outcome).toEqual({ "msg-0": "retry:30", "msg-1": "ack" });
  });

  test("unknown jobs, invalid input and foreign messages are acked, not retried", async () => {
    let calls = 0;
    const { app } = make(() => void calls++);
    const { batch, outcome } = fakeBatch([{ body: msg("ghost", {}) }, { body: msg("work", { n: "x" }) }, { body: "not ours" }, { body: { job: 5 } }]);
    await app.queue(batch, {}, {});
    expect(calls).toBe(0);
    expect(Object.values(outcome)).toEqual(["ack", "ack", "ack", "ack"]);
  });

  test("with `queue` set, batches from other queues are left alone", async () => {
    let calls = 0;
    const { app } = make(() => void calls++, { queue: "jobs" });
    const other = fakeBatch([{ body: msg("work", { n: 1 }) }], "emails");
    await app.queue(other.batch, {}, {});
    expect(other.outcome).toEqual({});
    const mine = fakeBatch([{ body: msg("work", { n: 1 }) }], "jobs");
    await app.queue(mine.batch, {}, {});
    expect(mine.outcome).toEqual({ "msg-0": "ack" });
    expect(calls).toBe(1);
  });

  test("jobs can dispatch follow-ups through the consumer's env", async () => {
    const JOBS = fakeQueue();
    const next = defineJob("next", { input: t.object({}), run: () => {} });
    const first = defineJob("first", { input: t.object({}), run: async ({ dispatch }) => void (await dispatch(next, {})) });
    const app = miu({ plugins: [queue({ jobs: [first, next], adapter: cloudflareQueue() })], ...silent });
    const { batch, outcome } = fakeBatch([{ body: msg("first", {}) }]);
    await app.queue(batch, { JOBS }, {});
    expect(outcome).toEqual({ "msg-0": "ack" });
    expect((JOBS.sent[0].body as QueueMessage).job).toBe("next");
  });

  test("retry delays are capped at 12h", async () => {
    const { app } = make(
      () => {
        throw new Error("x");
      },
      { backoff: 100_000 },
    );
    const { batch, outcome } = fakeBatch([{ body: msg("work", { n: 1 }) }]);
    await app.queue(batch, {}, {});
    expect(outcome).toEqual({ "msg-0": "retry:43200" });
  });
});

describe("cloudflareQueue: cron triggers", () => {
  test("scheduled() dispatches the schedules whose cron matches controller.cron", async () => {
    const JOBS = fakeQueue();
    const hourly = defineJob("hourly", { input: t.object({ kind: t.string() }), run: () => {} });
    const daily = defineJob("daily", { input: t.object({}), run: () => {} });
    const q = queue({
      schedules: [schedule("0 * * * *", hourly, { kind: "a" }), schedule("0  *  * * *", hourly, { kind: "b" }), schedule("0 0 * * *", daily)],
      adapter: cloudflareQueue(),
    });
    const app = miu({ plugins: [q], ...silent });
    await app.scheduled({ cron: "0 * * * *", scheduledTime: Date.now() }, { JOBS }, {});
    expect(JOBS.sent.map((s) => [(s.body as QueueMessage).job, (s.body as QueueMessage).input])).toEqual([
      ["hourly", { kind: "a" }],
      ["hourly", { kind: "b" }],
    ]);
  });
});

describe("cloudflareQueue: metadata", () => {
  test("cloudflare() declares the queue binding and the cron triggers", () => {
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    const q = queue({ schedules: [schedule("*/5 * * * *", job), schedule("*/5  * * * *", job), schedule("0 0 * * *", job)], adapter: cloudflareQueue({ binding: "TASKS" }) });
    expect(q.cloudflare!()).toEqual({ queues: { producers: ["TASKS"], consumers: ["TASKS"] }, crons: ["*/5 * * * *", "0 0 * * *"] });
  });

  test("inspect shows the adapter and binding", () => {
    const info = queue({ jobs: [], adapter: cloudflareQueue({ binding: "TASKS", queue: "tasks" }) }).inspect() as any;
    expect(info).toMatchObject({ adapter: "cloudflare", binding: "TASKS", queue: "tasks" });
  });
});
