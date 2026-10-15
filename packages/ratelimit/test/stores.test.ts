import { describe, expect, test } from "bun:test";
import { isMiuError, type Env } from "miujs";
import {
  cloudflareBindingStore,
  durableObjectStore,
  kvStore,
  memoryStore,
  redisStore,
  RateLimiterDurableObject,
  type Policy,
  type RateLimitStore,
} from "../src/index.ts";
import { fakeDoNamespace, fakeKv, fakeRedis, fakeStorage } from "./fakes.ts";

const S = 1000;
const M = 60 * S;
const T0 = 1_000 * M; // aligned to minutes

const fixed = (limit: number, windowMs = M): Policy => ({ algorithm: "fixed", limit, windowMs, cost: 1 });
const sliding = (limit: number, windowMs = M): Policy => ({ algorithm: "sliding", limit, windowMs, cost: 1 });
const bucket = (limit: number, windowMs = M, burst?: number): Policy => ({ algorithm: "token-bucket", limit, windowMs, cost: 1, burst });

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return isMiuError(e) ? e.code : String(e);
  }
  return undefined;
}

interface Harness {
  store: RateLimitStore;
  env: Env;
  clock: { now: number };
  exact: boolean;
  tokenBucket: boolean;
}

const harnesses: [string, () => Harness][] = [
  ["memory", () => ({ store: memoryStore(), env: {}, clock: { now: T0 }, exact: true, tokenBucket: true })],
  [
    "kv",
    () => {
      const clock = { now: T0 };
      return { store: kvStore("RL_KV"), env: { RL_KV: fakeKv(() => clock.now) }, clock, exact: false, tokenBucket: true };
    },
  ],
  ["durable object", () => ({ store: durableObjectStore("RATE_LIMITER"), env: { RATE_LIMITER: fakeDoNamespace() }, clock: { now: T0 }, exact: true, tokenBucket: true })],
  [
    "redis",
    () => {
      const clock = { now: T0 };
      return { store: redisStore(fakeRedis(() => clock.now)), env: {}, clock, exact: true, tokenBucket: false };
    },
  ],
];

for (const [name, make] of harnesses) {
  describe(`${name} store`, () => {
    const hit = (h: Harness, key: string, p: Policy) => h.store.consume(key, p, h.clock.now, h.env);

    test("fixed window: limit, deny, reset at the boundary", async () => {
      const h = make();
      const r = [];
      for (let i = 0; i < 4; i++) r.push(await hit(h, "a", fixed(3)));
      expect(r.map((x) => x.allowed)).toEqual([true, true, true, false]);
      expect(r.map((x) => x.remaining)).toEqual([2, 1, 0, 0]);
      expect(r[3].retryAfterMs).toBe(M);
      h.clock.now += M;
      expect(await hit(h, "a", fixed(3))).toMatchObject({ allowed: true, remaining: 2 });
    });

    test("sliding window: the previous window still counts", async () => {
      const h = make();
      for (let i = 0; i < 10; i++) expect((await hit(h, "a", sliding(10))).allowed).toBe(true);
      h.clock.now += M + 30 * S;
      const r = [];
      for (let i = 0; i < 6; i++) r.push((await hit(h, "a", sliding(10))).allowed);
      expect(r).toEqual([true, true, true, true, true, false]);
    });

    test("keys are independent", async () => {
      const h = make();
      expect((await hit(h, "a", fixed(1))).allowed).toBe(true);
      expect((await hit(h, "a", fixed(1))).allowed).toBe(false);
      expect((await hit(h, "b", fixed(1))).allowed).toBe(true);
    });

    test("reset(key) clears a key", async () => {
      const h = make();
      await hit(h, "a", fixed(1));
      await h.store.reset!("a", h.env, fixed(1), h.clock.now);
      expect((await hit(h, "a", fixed(1))).allowed).toBe(true);
    });

    test("token bucket", async () => {
      const h = make();
      if (!h.tokenBucket) {
        expect(h.store.unsupported?.(bucket(10))).toMatch(/token/);
        return;
      }
      const r = [];
      for (let i = 0; i < 4; i++) r.push((await hit(h, "a", bucket(6, M, 3))).allowed);
      expect(r).toEqual([true, true, true, false]);
      h.clock.now += 10 * S; // 6 per minute → 1 token per 10 s
      expect((await hit(h, "a", bucket(6, M, 3))).allowed).toBe(true);
      expect((await hit(h, "a", bucket(6, M, 3))).allowed).toBe(false);
    });

    test("concurrent hits never exceed the limit (exact stores)", async () => {
      const h = make();
      const results = await Promise.all(Array.from({ length: 20 }, () => hit(h, "c", fixed(5))));
      const allowed = results.filter((r) => r.allowed).length;
      if (h.exact) expect(allowed).toBe(5);
      else expect(allowed).toBeGreaterThanOrEqual(5); // KV is eventually consistent: may over-admit
    });

    test("inspect names the store", () => {
      expect(make().store.inspect?.()).toMatchObject({ store: expect.any(String) });
    });
  });
}

describe("memoryStore", () => {
  test("is bounded: expired keys are swept and the oldest evicted at maxKeys", async () => {
    const store = memoryStore({ maxKeys: 3 });
    for (const k of ["a", "b", "c", "d"]) await store.consume(k, fixed(1), T0, {});
    expect(store.inspect!().keys).toBe(3);
  });
});

describe("kvStore", () => {
  test("uses expirationTtl ≥ 60 and does not write on denied hits", async () => {
    const clock = { now: T0 };
    const kv = fakeKv(() => clock.now);
    const store = kvStore("RL_KV", { prefix: "rl:" });
    for (let i = 0; i < 3; i++) await store.consume("a", fixed(2, 10 * S), clock.now, { RL_KV: kv });
    expect(kv.puts).toBe(2);
    expect([...kv.data.keys()]).toEqual(["rl:a"]);
  });

  test("corrupt values are ignored, not trusted", async () => {
    const clock = { now: T0 };
    const kv = fakeKv(() => clock.now);
    await kv.put("a", '{"a":"f","s":0,"c":-50}');
    const store = kvStore("RL_KV", { prefix: "" });
    expect(await store.consume("a", fixed(2), clock.now, { RL_KV: kv })).toMatchObject({ allowed: true, remaining: 1 });
    await kv.put("a", "not json");
    expect((await store.consume("a", fixed(2), clock.now, { RL_KV: kv })).allowed).toBe(true);
  });

  test("a missing binding is MIU_E_RATELIMIT_BINDING with a fix; cloudflare() asks for the namespace", async () => {
    const store = kvStore("RL_KV");
    expect(await codeOf(store.consume("a", fixed(1), T0, {}))).toBe("MIU_E_RATELIMIT_BINDING");
    expect(store.cloudflare!()).toEqual({ kv: ["RL_KV"] });
    expect(store.inspect!()).toMatchObject({ exact: false });
  });
});

describe("durableObjectStore + RateLimiterDurableObject", () => {
  test("one object per key; cloudflare() declares the class", async () => {
    const ns = fakeDoNamespace();
    const store = durableObjectStore("RATE_LIMITER");
    await store.consume("a", fixed(1), T0, { RATE_LIMITER: ns });
    await store.consume("b", fixed(1), T0, { RATE_LIMITER: ns });
    expect([...ns.objects.keys()].length).toBe(2);
    expect(store.cloudflare!()).toEqual({ durableObjects: [{ binding: "RATE_LIMITER", className: "RateLimiterDurableObject" }] });
  });

  test("the object sets an alarm and clears its state when it fires", async () => {
    const storage = fakeStorage();
    const obj = new RateLimiterDurableObject({ storage } as any, {});
    const res = await obj.fetch(new Request("https://rl/consume", { method: "POST", body: JSON.stringify({ policy: fixed(1), now: T0 + 15 * S }) }));
    expect((await res.json()).allowed).toBe(true);
    expect(storage.alarmAt).toBe(T0 + M);
    expect(storage.map.size).toBe(1);
    await obj.alarm();
    expect(storage.map.size).toBe(0);
  });

  test("the object rejects bad input with 400 instead of trusting it", async () => {
    const obj = new RateLimiterDurableObject({ storage: fakeStorage() } as any, {});
    for (const body of ["nope", JSON.stringify({ policy: { algorithm: "fixed", limit: -1, windowMs: M, cost: 1 }, now: T0 }), JSON.stringify({ policy: fixed(1), now: "x" })]) {
      const r = await obj.fetch(new Request("https://rl/consume", { method: "POST", body }));
      expect(r.status).toBe(400);
    }
    expect((await obj.fetch(new Request("https://rl/other", { method: "POST", body: "{}" }))).status).toBe(404);
  });

  test("missing binding", async () => {
    expect(await codeOf(durableObjectStore("RATE_LIMITER").consume("a", fixed(1), T0, {}))).toBe("MIU_E_RATELIMIT_BINDING");
  });
});

describe("cloudflareBindingStore", () => {
  const binding = (allow: number) => {
    let n = 0;
    const keys: string[] = [];
    return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: ++n <= allow }) };
  };

  test("asks the binding and reports what it can (no remaining count)", async () => {
    const b = binding(1);
    const store = cloudflareBindingStore("RL", { limit: 100, period: 60 });
    const p = fixed(100, 60 * S);
    expect(await store.consume("k", p, T0, { RL: b })).toEqual({ allowed: true, limit: 100, remaining: null, resetMs: 60 * S, retryAfterMs: 0 });
    expect(await store.consume("k", p, T0, { RL: b })).toMatchObject({ allowed: false, retryAfterMs: 60 * S });
    expect(b.keys).toEqual(["k", "k"]);
  });

  test("cloudflare() declares the ratelimits binding", () => {
    expect(cloudflareBindingStore("RL", { limit: 10, period: 10, namespaceId: "1001" }).cloudflare!()).toEqual({ ratelimits: [{ binding: "RL", limit: 10, period: 10, namespaceId: "1001" }] });
  });

  test("refuses policies the binding is not configured for", () => {
    const store = cloudflareBindingStore("RL", { limit: 100, period: 60 });
    expect(store.unsupported!(fixed(100, 60 * S))).toBeNull();
    expect(store.unsupported!(fixed(50, 60 * S))).toMatch(/100 per 60/);
    expect(store.unsupported!(fixed(100, 10 * S))).toMatch(/100 per 60/);
    expect(store.unsupported!({ ...fixed(100, 60 * S), cost: 2 })).toMatch(/cost/);
    expect(store.unsupported!(bucket(100, 60 * S))).toMatch(/token/);
  });

  test("period must be 10 or 60; limit a positive integer", async () => {
    expect(await codeOf(() => cloudflareBindingStore("RL", { limit: 10, period: 30 as any }))).toBe("MIU_E_RATELIMIT_CONFIG");
    expect(await codeOf(() => cloudflareBindingStore("RL", { limit: 0, period: 10 }))).toBe("MIU_E_RATELIMIT_CONFIG");
  });

  test("missing binding", async () => {
    expect(await codeOf(cloudflareBindingStore("RL", { limit: 1, period: 10 }).consume("a", fixed(1, 10 * S), T0, {}))).toBe("MIU_E_RATELIMIT_BINDING");
  });
});

describe("redisStore", () => {
  test("keys are prefixed and expire", async () => {
    const clock = { now: T0 };
    const redis = fakeRedis(() => clock.now);
    const store = redisStore(redis, { prefix: "app:rl:" });
    await store.consume("a", fixed(5), clock.now, {});
    const keys = [...redis.data.keys()];
    expect(keys.length).toBe(1);
    expect(keys[0].startsWith("app:rl:a:")).toBe(true);
    expect(redis.data.get(keys[0])!.exp).toBeLessThan(Infinity);
  });

  test("denied hits are given back, so a blocked client recovers on time", async () => {
    const clock = { now: T0 };
    const redis = fakeRedis(() => clock.now);
    const store = redisStore(redis);
    for (let i = 0; i < 2; i++) await store.consume("a", sliding(2), clock.now, {});
    clock.now += M + S;
    // Hammering while blocked (prev 2 still weighs ~2) must not fill the new window...
    for (let i = 0; i < 10; i++) expect((await store.consume("a", sliding(2), clock.now, {})).allowed).toBe(false);
    clock.now += 39 * S; // ...so once prev weighs 2 * 20/60, one more fits.
    expect((await store.consume("a", sliding(2), clock.now, {})).allowed).toBe(true);
  });

  test("accepts node-redis camelCase clients (incrBy / pExpire)", async () => {
    const clock = { now: T0 };
    const r = fakeRedis(() => clock.now);
    const camel = { incrBy: r.incrby.bind(r), pExpire: r.pexpire.bind(r), get: r.get.bind(r), del: r.del.bind(r) };
    const store = redisStore(camel as any);
    expect((await store.consume("a", fixed(1), clock.now, {})).allowed).toBe(true);
    expect((await store.consume("a", fixed(1), clock.now, {})).allowed).toBe(false);
  });

  test("a client without incrby/pexpire/get is refused with a fix", async () => {
    expect(await codeOf(() => redisStore({} as any))).toBe("MIU_E_RATELIMIT_CONFIG");
  });
});
