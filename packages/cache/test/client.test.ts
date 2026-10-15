import { describe, expect, test } from "bun:test";
import { createCache, memoryStore } from "../src/index.ts";

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect((e as any).fix).toBeTruthy();
    return (e as any).code;
  }
  return undefined;
}

describe("CacheClient basics", () => {
  test("set/get round-trips JSON values and returns copies", async () => {
    const c = createCache(memoryStore());
    const v = { a: 1, list: [1, 2], nested: { ok: true } };
    await c.set("k", v);
    const got = await c.get<typeof v>("k");
    expect(got).toEqual(v);
    got!.a = 99;
    expect((await c.get<typeof v>("k"))!.a).toBe(1);
  });

  test("get returns undefined on a miss; delete removes", async () => {
    const c = createCache(memoryStore());
    expect(await c.get("nope")).toBeUndefined();
    await c.set("k", 0);
    expect(await c.get("k")).toBe(0);
    await c.delete("k");
    expect(await c.get("k")).toBeUndefined();
  });

  test("ttl is honored", async () => {
    let now = 0;
    const c = createCache(memoryStore({ now: () => now }));
    await c.set("k", "v", { ttl: 5 });
    now = 5_000;
    expect(await c.get("k")).toBeUndefined();
  });

  test("rejects values that are not JSON", async () => {
    const c = createCache(memoryStore());
    expect(await codeOf(c.set("k", undefined))).toBe("MIU_E_CACHE_VALUE");
    expect(await codeOf(c.set("k", 10n))).toBe("MIU_E_CACHE_VALUE");
    expect(await codeOf(c.set("k", () => 1))).toBe("MIU_E_CACHE_VALUE");
  });

  test("rejects bad keys, tags and ttls", async () => {
    const c = createCache(memoryStore());
    expect(await codeOf(c.set("", 1))).toBe("MIU_E_CACHE_KEY");
    expect(await codeOf(c.get(""))).toBe("MIU_E_CACHE_KEY");
    expect(await codeOf(c.set("k", 1, { tags: [""] }))).toBe("MIU_E_CACHE_KEY");
    expect(await codeOf(c.set("k", 1, { ttl: -1 }))).toBe("MIU_E_CACHE_TTL");
    expect(await codeOf(c.set("k", 1, { ttl: Number.NaN }))).toBe("MIU_E_CACHE_TTL");
    expect(await codeOf(c.remember("k", 0, () => 1))).toBe("MIU_E_CACHE_TTL");
  });

  test("a corrupted stored value is treated as a miss", async () => {
    const store = memoryStore();
    await store.set("k", "{not json");
    const c = createCache(store);
    expect(await c.get("k")).toBeUndefined();
  });
});

describe("remember", () => {
  test("computes once and then serves from cache", async () => {
    const c = createCache(memoryStore());
    let calls = 0;
    const fn = async () => ({ n: ++calls });
    expect(await c.remember("k", 60, fn)).toEqual({ n: 1 });
    expect(await c.remember("k", 60, fn)).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  test("concurrent callers share one in-flight computation", async () => {
    const c = createCache(memoryStore());
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = async () => {
      calls++;
      await gate;
      return "value";
    };
    const all = Promise.all([c.remember("k", 60, fn), c.remember("k", 60, fn), c.remember("k", 60, fn)]);
    await Promise.resolve();
    release();
    expect(await all).toEqual(["value", "value", "value"]);
    expect(calls).toBe(1);
  });

  test("a failing computation is not cached and the next call retries", async () => {
    const c = createCache(memoryStore());
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };
    await expect(c.remember("k", 60, fn)).rejects.toThrow("boom");
    expect(await c.remember("k", 60, fn)).toBe("ok");
    expect(calls).toBe(2);
  });

  test("respects the ttl", async () => {
    let now = 0;
    const c = createCache(memoryStore({ now: () => now }));
    let calls = 0;
    await c.remember("k", 10, () => ++calls);
    now = 10_000;
    expect(await c.remember("k", 10, () => ++calls)).toBe(2);
  });

  test("different keys compute independently", async () => {
    const c = createCache(memoryStore());
    expect(await Promise.all([c.remember("a", 60, () => "A"), c.remember("b", 60, () => "B")])).toEqual(["A", "B"]);
  });
});

describe("tags", () => {
  test("invalidateTag deletes every key set with that tag", async () => {
    const c = createCache(memoryStore());
    await c.set("user:1", 1, { tags: ["users"] });
    await c.set("user:2", 2, { tags: ["users", "admins"] });
    await c.set("post:1", 3, { tags: ["posts"] });
    await c.invalidateTag("users");
    expect(await c.get("user:1")).toBeUndefined();
    expect(await c.get("user:2")).toBeUndefined();
    expect(await c.get("post:1")).toBe(3);
  });

  test("concurrent tagged sets all land in the index", async () => {
    const c = createCache(memoryStore());
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.set(`k${i}`, i, { tags: ["t"] })));
    await c.invalidateTag("t");
    for (let i = 0; i < 20; i++) expect(await c.get(`k${i}`)).toBeUndefined();
  });

  test("tagged keys set after invalidation are tracked fresh", async () => {
    const c = createCache(memoryStore());
    await c.set("a", 1, { tags: ["t"] });
    await c.invalidateTag("t");
    await c.set("b", 2, { tags: ["t"] });
    await c.invalidateTag("t");
    expect(await c.get("b")).toBeUndefined();
  });

  test("invalidating an unknown tag is a no-op", async () => {
    const c = createCache(memoryStore());
    await c.invalidateTag("nothing");
  });

  test("tag index keys do not collide with user keys", async () => {
    const c = createCache(memoryStore());
    await c.set("users", "plain value");
    await c.set("u1", 1, { tags: ["users"] });
    await c.invalidateTag("users");
    expect(await c.get("users")).toBe("plain value");
  });
});
