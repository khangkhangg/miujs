import { describe, expect, test } from "bun:test";
import {
  fromIoredis,
  fromNodeRedis,
  redisScript,
  redisStore,
  toRedisLike,
  type RedisLike,
} from "../../src/batteries/store/redis.ts";
import { redisQueueDriver } from "../../src/batteries/queue/redis.ts";
import { createQueue } from "../../src/batteries/queue/queue.ts";
import { testRedis } from "./redis-server.ts";

const redis = await testRedis();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Redis client adapters", () => {
  test("ioredis: call(command, ...args)", async () => {
    const calls: unknown[][] = [];
    const io = { call: async (...a: unknown[]) => (calls.push(a), "OK") };
    expect(await fromIoredis(io).send("SET", ["k", "v"])).toBe("OK");
    expect(await toRedisLike(io).send("GET", ["k"])).toBe("OK");
    expect(calls).toEqual([["SET", "k", "v"], ["GET", "k"]]);
  });

  test("node-redis: sendCommand([command, ...args])", async () => {
    const calls: unknown[] = [];
    const nr = { sendCommand: async (a: string[]) => (calls.push(a), 1) };
    await fromNodeRedis(nr).send("DEL", ["k"]);
    await toRedisLike(nr).send("EXISTS", ["k"]);
    expect(calls).toEqual([["DEL", "k"], ["EXISTS", "k"]]);
  });

  test("Bun RedisClient (send) is used as-is; unknown clients are rejected", () => {
    const bunLike: RedisLike = { send: async () => null };
    expect(toRedisLike(bunLike)).toBe(bunLike);
    expect(() => toRedisLike({} as RedisLike)).toThrow(/Unsupported Redis client/);
  });

  test("scripts use EVALSHA and fall back to EVAL on NOSCRIPT", async () => {
    const seen: string[] = [];
    let cached = false;
    const fake: RedisLike = {
      async send(cmd, args) {
        seen.push(`${cmd}:${args.slice(1).join(",")}`);
        if (cmd === "EVALSHA" && !cached) throw new Error("NOSCRIPT No matching script");
        if (cmd === "EVAL") cached = true;
        return 7;
      },
    };
    const s = redisScript("return 7");
    expect(await s.run(fake, ["a"], [1])).toBe(7);
    expect(await s.run(fake, ["a"], [1])).toBe(7);
    expect(seen).toEqual(["EVALSHA:1,a,1", "EVAL:1,a,1", "EVALSHA:1,a,1"]);
    const failing: RedisLike = { send: async () => { throw new Error("WRONGTYPE"); } };
    await expect(s.run(failing, [], [])).rejects.toThrow(/WRONGTYPE/);
  });
});

describe.skipIf(!redis)("Store contract: redis (real redis-server)", () => {
  const make = () => redisStore(redis!.client, { prefix: redis!.prefix() });

  test("get on a missing key is undefined", async () => {
    expect(await make().get("nope")).toBeUndefined();
  });

  test("round-trips JSON values", async () => {
    const store = make();
    await store.set("obj", { a: 1, b: [true, "x"], c: null });
    await store.set("num", 42);
    await store.set("str", "hello");
    expect(await store.get("obj")).toEqual({ a: 1, b: [true, "x"], c: null });
    expect(await store.get<number>("num")).toBe(42);
    expect(await store.get("str")).toBe("hello");
  });

  test("set overwrites; delete reports whether the key existed", async () => {
    const store = make();
    await store.set("k", 1);
    await store.set("k", 2);
    expect(await store.get("k")).toBe(2);
    expect(await store.delete("k")).toBe(true);
    expect(await store.delete("k")).toBe(false);
    expect(await store.has("k")).toBe(false);
  });

  test("ttl expires values; set without ttl clears a previous ttl", async () => {
    const store = make();
    await store.set("k", "v", { ttl: 0.15 });
    await store.set("keep", 1, { ttl: 0.15 });
    await store.set("keep", 2);
    expect(await store.get("k")).toBe("v");
    await sleep(250);
    expect(await store.get("k")).toBeUndefined();
    expect(await store.has("k")).toBe(false);
    expect(await store.get("keep")).toBe(2);
  });

  test("incr creates, increments and returns the new value", async () => {
    const store = make();
    expect(await store.incr("c")).toBe(1);
    expect(await store.incr("c")).toBe(2);
    expect(await store.incr("c", 5)).toBe(7);
    expect(await store.get("c")).toBe(7);
    expect(await store.incr("f", 0.5)).toBe(0.5);
    expect(await store.incr("f", 0.25)).toBe(0.75);
  });

  test("incr ttl applies only when the counter is created", async () => {
    const store = make();
    await store.incr("c", 1, { ttl: 0.3 });
    await sleep(150);
    await store.incr("c", 1, { ttl: 0.3 }); // must not extend the window
    await sleep(200);
    expect(await store.get("c")).toBeUndefined();
    expect(await store.incr("c", 1, { ttl: 10 })).toBe(1);
    expect(await store.ttl("c")).toBe(10);
  });

  test("incr is atomic under concurrency", async () => {
    const store = make();
    const results = await Promise.all(Array.from({ length: 200 }, () => store.incr("hits", 1, { ttl: 60 })));
    expect(new Set(results).size).toBe(200);
    expect(Math.max(...results)).toBe(200);
  });

  test("ttl returns remaining seconds, -1 without expiry, undefined when missing", async () => {
    const store = make();
    await store.set("a", 1, { ttl: 60 });
    await store.set("b", 1);
    expect(await store.ttl("a")).toBe(60);
    expect(await store.ttl("b")).toBe(-1);
    expect(await store.ttl("zzz")).toBeUndefined();
  });

  test("keys are isolated with prefix(), and the store prefix namespaces everything", async () => {
    const prefix = redis!.prefix();
    const store = redisStore(redis!.client, { prefix });
    const a = store.prefix("a:");
    const b = store.prefix("b:");
    await a.set("x", 1);
    await b.set("x", 2);
    expect(await a.get("x")).toBe(1);
    expect(await b.get("x")).toBe(2);
    expect(await store.get("a:x")).toBe(1);
    expect(await redis!.client.send("GET", [`${prefix}a:x`])).toBe("1");
    await store.close();
    expect(await a.get("x")).toBe(1); // close() leaves the caller's client open
  });

  test("works through the ioredis-style adapter too", async () => {
    const io = { call: (cmd: string, ...args: (string | number)[]) => redis!.client.send(cmd, args.map(String)) };
    const store = redisStore(io, { prefix: redis!.prefix() });
    expect(await store.incr("n", 3, { ttl: 5 })).toBe(3);
    await store.set("o", { ok: true });
    expect(await store.get("o")).toEqual({ ok: true });
  });
});

describe.skipIf(!redis)("redisQueueDriver (real redis-server)", () => {
  const job = (id: string, runAt: number, extra: Record<string, unknown> = {}) => ({
    id, name: "x", payload: { id }, status: "pending" as const, attempts: 0, runAt, createdAt: runAt, ...extra,
  });

  test("two drivers (separate connections) never claim the same job", async () => {
    const { RedisClient } = await import("bun");
    const other = new RedisClient(redis!.url);
    const prefix = redis!.prefix();
    const a = redisQueueDriver(redis!.client, { prefix });
    const b = redisQueueDriver(other, { prefix });
    for (let i = 0; i < 30; i++) await a.push(job(`j${i}`, i));
    const claims = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).claim(1000, 60_000)));
    const ids = claims.filter((c) => c !== undefined).map((c) => c.id);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    other.close();
  });

  test("jobs due at the same time run in dispatch order", async () => {
    const d = redisQueueDriver(redis!.client, { prefix: redis!.prefix() });
    for (const id of ["z", "a", "m"]) await d.push(job(id, 5));
    const order = [];
    for (let i = 0; i < 3; i++) order.push((await d.claim(10, 1000))!.id);
    expect(order).toEqual(["z", "a", "m"]);
  });

  test("concurrent dispatches with the same key create one job", async () => {
    const queue = createQueue({ driver: redisQueueDriver(redis!.client, { prefix: redis!.prefix() }) });
    const ids = await Promise.all(Array.from({ length: 20 }, () => queue.dispatch("x", {}, { key: "once" })));
    expect(new Set(ids).size).toBe(1);
  });

  test("payloads and errors with special characters survive", async () => {
    const d = redisQueueDriver(redis!.client, { prefix: redis!.prefix() });
    const payload = { s: "quote\" back\\slash 'lua' ]] \n ünïcødé 🐱", n: 1.5, big: 2 ** 52 };
    await d.push({ ...job("p", 0), payload });
    const c = (await d.claim(1, 1000))!;
    expect(c.payload).toEqual(payload);
    await d.fail("p", "boom ]] 'x' \"y\"", null, 2, c.attempts);
    expect(await d.get("p")).toMatchObject({ status: "failed", lastError: "boom ]] 'x' \"y\"", finishedAt: 2 });
  });

  test("prune removes completed jobs in batches", async () => {
    const d = redisQueueDriver(redis!.client, { prefix: redis!.prefix() });
    for (let i = 0; i < 1200; i++) await d.push(job(`j${i}`, 0));
    for (let i = 0; i < 1200; i++) {
      const c = (await d.claim(1, 1000))!;
      await d.complete(c.id, 5, c.attempts);
    }
    expect(await d.prune(5)).toBe(1200);
    expect(await d.list()).toEqual([]);
  });
});
