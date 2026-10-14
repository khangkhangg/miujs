import { describe, expect, test } from "bun:test";
import { createQueue } from "../../src/batteries/queue/queue.ts";
import { memoryQueueDriver } from "../../src/batteries/queue/memory.ts";
import { ValidationError } from "../../src/core/errors.ts";
import { t } from "../../src/core/schema.ts";
import { cloudflareQueue, queueConsumer, type CloudflareJobMessage } from "../../src/adapters/cloudflare/queues.ts";
import { fakeBatch, fakeMessage, fakeQueueProducer } from "./fakes.ts";

const setup = () => {
  const queue = createQueue({ driver: memoryQueueDriver() });
  const seen: unknown[] = [];
  queue.define("email", {
    schema: t.object({ to: t.string() }),
    handler: (p, job) => void seen.push([p.to, job.attempts, job.id]),
  });
  let fails = 0;
  queue.define("flaky", {
    retries: 2,
    backoff: (attempt) => attempt * 1500,
    handler: () => {
      fails++;
      throw new Error("boom");
    },
  });
  return { queue, seen, fails: () => fails };
};

describe("cloudflareQueue (producer)", () => {
  test("sends { id, name, payload } with delaySeconds", async () => {
    const { queue } = setup();
    const binding = fakeQueueProducer<CloudflareJobMessage>();
    const q = cloudflareQueue(queue, binding);
    const id = await q.dispatch("email", { to: "a@b.c" }, { delay: 30 });
    expect(binding.sent).toEqual([{ body: { id, name: "email", payload: { to: "a@b.c" } }, options: { delaySeconds: 30 } }]);
    await q.dispatch("email", { to: "x" });
    expect(binding.sent[1]!.options).toEqual({});
  });

  test("validates payloads of jobs defined on the Miu queue", async () => {
    const { queue } = setup();
    const binding = fakeQueueProducer();
    const q = cloudflareQueue(queue, () => binding);
    await expect(q.dispatch("email", { to: 1 })).rejects.toBeInstanceOf(ValidationError);
    await q.dispatch("unknown-job", { anything: true });
    expect(binding.sent).toHaveLength(1);
  });

  test("clamps delay to the Queues maximum of 12 hours", async () => {
    const { queue } = setup();
    const binding = fakeQueueProducer();
    await cloudflareQueue(queue, binding).dispatch("email", { to: "x" }, { delay: 999_999 });
    expect(binding.sent[0]!.options).toEqual({ delaySeconds: 43_200 });
  });
});

describe("queueConsumer", () => {
  test("runs the matching handler and acks", async () => {
    const { queue, seen } = setup();
    const m = fakeMessage<CloudflareJobMessage>({ id: "j1", name: "email", payload: { to: "a@b.c" } }, 2);
    await queueConsumer(queue)(fakeBatch([m]), {}, { waitUntil() {} });
    expect(seen).toEqual([["a@b.c", 2, "j1"]]);
    expect(m.acked).toBe(true);
    expect(m.retried).toBeNull();
  });

  test("retries with the job's backoff until retries are exhausted, then acks and reports failure", async () => {
    const { queue } = setup();
    const events: string[] = [];
    const consumer = queueConsumer(queue, { onEvent: (e) => events.push(`${e.type}:${e.job.attempts}:${e.error}`) });
    const body = { id: "f", name: "flaky", payload: null };
    const m1 = fakeMessage<CloudflareJobMessage>(body, 1);
    const m2 = fakeMessage<CloudflareJobMessage>(body, 2);
    const m3 = fakeMessage<CloudflareJobMessage>(body, 3);
    await consumer(fakeBatch([m1, m2, m3]), {}, { waitUntil() {} });
    expect(m1.retried).toEqual({ delaySeconds: 2 }); // 1500ms rounds up
    expect(m2.retried).toEqual({ delaySeconds: 3 });
    expect(m3.retried).toBeNull();
    expect(m3.acked).toBe(true);
    expect(events).toEqual(["retry:1:boom", "retry:2:boom", "failed:3:boom"]);
  });

  test("validates the payload again on consume", async () => {
    const { queue, seen } = setup();
    const m = fakeMessage<CloudflareJobMessage>({ id: "x", name: "email", payload: { to: 5 } });
    await queueConsumer(queue)(fakeBatch([m]), {}, { waitUntil() {} });
    expect(seen).toEqual([]);
    expect(m.acked).toBe(true);
  });

  test("unknown jobs and malformed bodies fail permanently (ack) and are reported", async () => {
    const { queue } = setup();
    const events: string[] = [];
    const m1 = fakeMessage({ id: "x", name: "nope", payload: 1 } as CloudflareJobMessage);
    const m2 = fakeMessage("garbage" as unknown as CloudflareJobMessage);
    await queueConsumer(queue, { onEvent: (e) => events.push(e.type) })(fakeBatch([m1, m2]), {}, { waitUntil() {} });
    expect(m1.acked && m2.acked).toBe(true);
    expect(events).toEqual(["failed", "failed"]);
  });

  test("a job exceeding its timeout is retried and its signal aborts", async () => {
    const queue = createQueue({ driver: memoryQueueDriver() });
    let aborted = false;
    queue.define("slow", {
      timeout: 10,
      handler: (_p, job) =>
        new Promise((r) => {
          job.signal.addEventListener("abort", () => ((aborted = true), r(undefined)));
        }),
    });
    const m = fakeMessage<CloudflareJobMessage>({ id: "s", name: "slow", payload: null });
    await queueConsumer(queue)(fakeBatch([m]), {}, { waitUntil() {} });
    expect(aborted).toBe(true);
    expect(m.retried).toEqual({ delaySeconds: 1 });
  });
});
