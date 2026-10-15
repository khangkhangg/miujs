import { describe, expect, test } from "bun:test";
import { t } from "miujs";
import { fakeRedis, type FakeRedis } from "../../cache/test/fake-redis.ts";
import { defineJob, manualClock, queue, redisQueue } from "../src/index.ts";
import { durableSuite } from "./durable-suite.ts";
import { queueSuite } from "./queue-suite.ts";

queueSuite("redis queue", ({ clock, concurrency }) => {
  const rq = redisQueue(fakeRedis({ now: clock.now }).client, { clock, concurrency });
  return { adapter: rq, drain: () => rq.drain(), deadLetters: () => rq.listDeadLetters() };
});

// One fake Redis server shared by every instance; its TTL clock follows the test clock.
let current: ReturnType<typeof manualClock> | undefined;
durableSuite<FakeRedis>(
  "redis queue",
  () => fakeRedis({ now: () => current!.now() }),
  (redis, { clock, ...o }) => {
    current = clock;
    return redisQueue(redis.client, { clock, ...o });
  },
);

describe("redisQueue specifics", () => {
  test("keys live under the prefix", async () => {
    const r = fakeRedis();
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    const rq = redisQueue(r.client, { prefix: "app:q:" });
    const q = queue({ jobs: [job], adapter: rq });
    const { id } = await q.dispatch(job, {});
    await q.dispatch(job, {}, { delay: 10 });
    expect(r.keys().every((k) => k.startsWith("app:q:"))).toBe(true);
    expect(r.keys()).toContain(`app:q:job:${id}`);
    expect(rq.name).toBe("redis");
  });

  test("a Redis failure on dispatch is MIU_E_QUEUE_REDIS with a fix", async () => {
    const r = fakeRedis();
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    const q = queue({ jobs: [job], adapter: redisQueue(r.client) });
    r.failNext();
    const err = await q.dispatch(job, {}).catch((e) => e);
    expect(err.code).toBe("MIU_E_QUEUE_REDIS");
    expect(err.fix).toContain("REDIS_URL");
  });

  test("drain rejects when Redis keeps failing, instead of spinning", async () => {
    const r = fakeRedis();
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    const rq = redisQueue(r.client);
    const q = queue({ jobs: [job], adapter: rq });
    await q.dispatch(job, {});
    r.failCommands(["RPOPLPUSH"]); // claiming fails, but the job still looks ready
    const err = await rq.drain().catch((e) => e);
    expect(err.code).toBe("MIU_E_QUEUE_REDIS");
    expect(err.message).toContain("claim");
  });

  test("rejects a non-client; inspect has prefix and client info, no secrets", () => {
    expect(() => redisQueue({ get() {} } as any)).toThrow(expect.objectContaining({ code: "MIU_E_QUEUE_CONFIG" }) as any);
    const client = { ...fakeRedis().client, inspect: () => ({ url: "redis://u:***@h" }) };
    expect(redisQueue(client).inspect!()).toMatchObject({ prefix: "miu:queue:", client: { url: "redis://u:***@h" }, concurrency: 1, visibilityTimeout: 30 });
  });
});
