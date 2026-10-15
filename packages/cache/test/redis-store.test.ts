import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { _bunRedisWith, bunRedis, createCache, redisFromCommand, redisStore } from "../src/index.ts";
import { fakeRedis } from "./fake-redis.ts";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(isMiuError(e)).toBe(true);
    expect((e as any).fix).toBeTruthy();
    return (e as any).code;
  }
  throw new Error("expected a throw");
}

describe("redisFromCommand (RedisLike over a raw `send(cmd, args)`)", () => {
  test("translates calls to Redis commands with string arguments", async () => {
    const sent: string[][] = [];
    const replies: unknown[] = ["OK", null, 2, 1, 1, 7, 1, ["a"], 1, "3", 1, 2, "x", 1, ["y"], 4, null];
    const r = redisFromCommand(async (cmd, args) => {
      sent.push([cmd, ...args]);
      return replies.shift();
    });
    expect(await r.set("k", "v", { px: 1500 })).toBe(true);
    expect(await r.set("k", "v", { ex: 10, nx: true })).toBe(false);
    expect(await r.del("a", "b")).toBe(2);
    expect(await r.expire("k", 5)).toBe(true);
    expect(await r.pexpire("k", 50)).toBe(true);
    expect(await r.incr("n")).toBe(7);
    expect(await r.zadd("z", 12.5, "a")).toBe(1);
    expect(await r.zrangebyscore("z", -Infinity, 20, 10)).toEqual(["a"]);
    expect(await r.zrem("z", "a")).toBe(1);
    expect(await r.zscore("z", "a")).toBe(3);
    expect(await r.zcard("z")).toBe(1);
    expect(await r.lpush("l", "x")).toBe(2);
    expect(await r.rpoplpush("l", "p")).toBe("x");
    expect(await r.lrem("p", "x")).toBe(1);
    expect(await r.lrange("p", 0, -1)).toEqual(["y"]);
    expect(await r.llen("p")).toBe(4);
    expect(await r.get("missing")).toBeNull();
    expect(sent).toEqual([
      ["SET", "k", "v", "PX", "1500"],
      ["SET", "k", "v", "EX", "10", "NX"],
      ["DEL", "a", "b"],
      ["EXPIRE", "k", "5"],
      ["PEXPIRE", "k", "50"],
      ["INCR", "n"],
      ["ZADD", "z", "12.5", "a"],
      ["ZRANGEBYSCORE", "z", "-inf", "20", "LIMIT", "0", "10"],
      ["ZREM", "z", "a"],
      ["ZSCORE", "z", "a"],
      ["ZCARD", "z"],
      ["LPUSH", "l", "x"],
      ["RPOPLPUSH", "l", "p"],
      ["LREM", "p", "0", "x"],
      ["LRANGE", "p", "0", "-1"],
      ["LLEN", "p"],
      ["GET", "missing"],
    ]);
  });

  test("accepts boolean replies for EXPIRE (RESP3 clients) and null scores", async () => {
    const replies: unknown[] = [true, false, null];
    const r = redisFromCommand(async () => replies.shift());
    expect(await r.expire("k", 1)).toBe(true);
    expect(await r.pexpire("k", 1)).toBe(false);
    expect(await r.zscore("z", "m")).toBeNull();
  });
});

describe("fake redis TTLs", () => {
  test("SET PX expires on the fake clock; NX only sets missing keys", async () => {
    const c = clock();
    const { client } = fakeRedis({ now: c.now });
    expect(await client.set("k", "1", { px: 100 })).toBe(true);
    expect(await client.set("k", "2", { nx: true })).toBe(false);
    c.advance(99);
    expect(await client.get("k")).toBe("1");
    c.advance(1);
    expect(await client.get("k")).toBeNull();
    expect(await client.set("k", "3", { nx: true })).toBe(true);
  });
});

describe("redisStore", () => {
  test("reads and writes under a key prefix", async () => {
    const r = fakeRedis();
    const s = redisStore(r.client, { prefix: "app:c:" });
    expect(s.name).toBe("redis");
    await s.set("a", '{"x":1}');
    expect(await s.get("a")).toBe('{"x":1}');
    expect(r.keys()).toEqual(["app:c:a"]);
    expect(await s.get("missing")).toBeUndefined();
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
  });

  test("the default prefix is miu:cache:", async () => {
    const r = fakeRedis();
    await redisStore(r.client).set("a", "1");
    expect(r.keys()).toEqual(["miu:cache:a"]);
  });

  test("ttl seconds become a PX expiry, including fractions", async () => {
    const c = clock();
    const r = fakeRedis({ now: c.now });
    const s = redisStore(r.client);
    await s.set("a", "1", { ttl: 1.5 });
    await s.set("b", "1");
    expect(r.log.slice(-2)).toEqual([
      ["SET", "miu:cache:a", "1", "PX", "1500"],
      ["SET", "miu:cache:b", "1"],
    ]);
    c.advance(1_499);
    expect(await s.get("a")).toBe("1");
    c.advance(1);
    expect(await s.get("a")).toBeUndefined();
    expect(await s.get("b")).toBe("1");
  });

  test("works under createCache, including tags and remember", async () => {
    const c = createCache(redisStore(fakeRedis().client));
    await c.set("a", { x: 1 }, { tags: ["t"], ttl: 10 });
    expect(await c.get("a")).toEqual({ x: 1 });
    await c.invalidateTag("t");
    expect(await c.get("a")).toBeUndefined();
    let calls = 0;
    expect(await c.remember("r", 5, () => ++calls)).toBe(1);
    expect(await c.remember("r", 5, () => ++calls)).toBe(1);
  });

  test("a Redis failure becomes MIU_E_CACHE_REDIS with a fix, keeping the cause", async () => {
    const r = fakeRedis();
    const s = redisStore(r.client);
    r.failNext();
    const err = await s.get("a").catch((e) => e);
    expect(err.code).toBe("MIU_E_CACHE_REDIS");
    expect(err.message).toContain("GET");
    expect(err.fix).toContain("REDIS_URL");
    expect(err.cause.message).toBe("Connection closed");
  });

  test("rejects something that is not a Redis client, and a bad prefix", () => {
    expect(code(() => redisStore({} as any))).toBe("MIU_E_CACHE_CONFIG");
    expect(code(() => redisStore(fakeRedis().client, { prefix: 3 as any }))).toBe("MIU_E_CACHE_CONFIG");
  });

  test("inspect shows the prefix and the client's own description", () => {
    const client = { ...fakeRedis().client, inspect: () => ({ url: "redis://***@host:6379" }) };
    expect(redisStore(client, { prefix: "p:" }).inspect!()).toEqual({ prefix: "p:", client: { url: "redis://***@host:6379" } });
  });
});

describe("bunRedis", () => {
  test("off Bun it fails with MIU_E_CACHE_REDIS_RUNTIME and a fix", () => {
    expect(code(() => _bunRedisWith(undefined, "workerd", "redis://x"))).toBe("MIU_E_CACHE_REDIS_RUNTIME");
  });

  test("adapts Bun's RedisClient through send(), and redacts the password in inspect", async () => {
    const calls: unknown[] = [];
    class FakeBunClient {
      constructor(url?: string, opts?: unknown) {
        calls.push(["new", url, opts]);
      }
      async send(cmd: string, args: string[]) {
        calls.push([cmd, ...args]);
        return "OK";
      }
      close() {
        calls.push(["close"]);
      }
    }
    const r = _bunRedisWith(FakeBunClient as any, "bun", "redis://me:s3cret@cache.local:6380/2", { autoReconnect: false });
    expect(await r.set("k", "v")).toBe(true);
    r.close!();
    expect(calls).toEqual([["new", "redis://me:s3cret@cache.local:6380/2", { autoReconnect: false }], ["SET", "k", "v"], ["close"]]);
    const info = JSON.stringify(r.inspect!());
    expect(info).not.toContain("s3cret");
    expect(r.inspect!()).toEqual({ client: "bun", url: "redis://me:***@cache.local:6380/2" });
  });

  test("on Bun, a refused connection surfaces as MIU_E_CACHE_REDIS through redisStore", async () => {
    const client = bunRedis("redis://127.0.0.1:1", { autoReconnect: false, connectionTimeout: 1000 });
    try {
      const err = await redisStore(client).get("a").catch((e) => e);
      expect(err.code).toBe("MIU_E_CACHE_REDIS");
    } finally {
      client.close!();
    }
  });
});

describe("redisStore key listing (SCAN)", () => {
  test("redisFromCommand sends SCAN cursor MATCH COUNT and returns [cursor, keys] as strings", async () => {
    const sent: string[][] = [];
    const r = redisFromCommand(async (cmd, args) => {
      sent.push([cmd, ...args]);
      return [17, ["a", "b"]];
    });
    expect(await r.scan!("0", { match: "p:*", count: 50 })).toEqual(["17", ["a", "b"]]);
    expect(await r.scan!("17")).toEqual(["17", ["a", "b"]]);
    expect(sent).toEqual([["SCAN", "0", "MATCH", "p:*", "COUNT", "50"], ["SCAN", "17"]]);
  });

  test("scan pages through this store's keys only, prefix stripped, each key exactly once", async () => {
    const r = fakeRedis();
    const store = redisStore(r.client, { prefix: "app:" });
    await r.client.set("other:x", "1"); // another app's key in the same Redis
    for (let i = 0; i < 25; i++) await store.set(`k${String(i).padStart(2, "0")}`, `"${i}"`);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.scan!({ limit: 4, cursor });
      expect(page.keys.length).toBeLessThanOrEqual(4);
      for (const k of page.keys) expect(k).toEqual({ key: k.key, bytes: null, expiresAt: null });
      seen.push(...page.keys.map((k) => k.key));
      cursor = page.next;
    } while (cursor && ++pages < 100);
    expect(seen.sort()).toEqual(Array.from({ length: 25 }, (_, i) => `k${String(i).padStart(2, "0")}`));
    expect(r.log.some(([cmd, , m, match]) => cmd === "SCAN" && m === "MATCH" && match === "app:*")).toBe(true);
  });

  test("a prefix filter is matched literally (glob characters escaped)", async () => {
    const r = fakeRedis();
    const store = redisStore(r.client);
    for (const k of ["a*b:1", "axb:1", "a?c", "abc", "a[b]", "ab"]) await store.set(k, "1");
    const keys = async (prefix: string) => (await store.scan!({ prefix, limit: 100 })).keys.map((k) => k.key).sort();
    expect(await keys("a*")).toEqual(["a*b:1"]);
    expect(await keys("a?")).toEqual(["a?c"]);
    expect(await keys("a[")).toEqual(["a[b]"]);
    expect(await keys("ab")).toEqual(["ab", "abc"]);
  });

  test("deleting the listed keys while paging (a purge) skips none of the rest", async () => {
    const r = fakeRedis();
    const store = redisStore(r.client);
    for (let i = 0; i < 300; i++) await store.set(`p:${i}`, "1");
    await store.set("q:keep", "1");
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await store.scan!({ prefix: "p:", limit: 7, cursor });
      for (const k of page.keys) await store.delete(k.key);
      deleted += page.keys.length;
      cursor = page.next;
    } while (cursor);
    expect(deleted).toBe(300);
    expect(r.keys()).toEqual(["miu:cache:q:keep"]);
  });

  test("an unknown cursor is a 400 with a fix", async () => {
    const store = redisStore(fakeRedis().client);
    const err = await store.scan!({ limit: 5, cursor: "nonsense" }).catch((e) => e);
    expect(err.code).toBe("MIU_E_BAD_REQUEST");
    expect(err.fix).toBeTruthy();
  });

  test("a client without scan still works as a cache, but cannot list", async () => {
    const { scan: _scan, ...client } = fakeRedis().client;
    const store = redisStore(client);
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
    expect(store.scan).toBeUndefined();
  });
});
