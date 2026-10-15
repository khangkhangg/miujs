// Memory health of the cache: LRU bound, TTL expiry, tag indexes and remember(). Each leak check
// runs thousands of operations and fails if live memory keeps growing after warm-up.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { createCache, memoryStore, TAG_PREFIX } from "../src/index.ts";
import { fakeRedis } from "./fake-redis.ts";
import { redisStore } from "../src/index.ts";

const PKG = join(import.meta.dir, "..");

describe("memoryStore", () => {
  test("never holds more than maxEntries, whatever the key pattern", async () => {
    const store = memoryStore({ maxEntries: 100 });
    const c = createCache(store);
    for (let i = 0; i < 5000; i++) {
      await c.set(`k${i}`, i, i % 2 ? { ttl: 60 } : undefined);
      if (i % 7 === 0) await c.get(`k${i - 3}`);
    }
    expect(store.size!()).toBeLessThanOrEqual(100);
  });

  test("never holds more than maxBytes of values (large values cannot exhaust memory)", async () => {
    const store = memoryStore({ maxEntries: 100_000, maxBytes: 10_000 });
    const big = "x".repeat(1000);
    for (let i = 0; i < 200; i++) await store.set(`b${i}`, big);
    expect(store.bytes!()).toBeLessThanOrEqual(10_000);
    expect(await store.get("b199")).toBe(big); // newest kept
    expect(await store.get("b0")).toBeUndefined();
    await store.set("huge", "y".repeat(20_000)); // larger than the whole budget: not stored
    expect(await store.get("huge")).toBeUndefined();
    expect(await store.get("b199")).toBe(big);
    expect(memoryStore().inspect!()).toMatchObject({ maxEntries: 1000, maxBytes: 64 * 1024 * 1024 });
  });

  test("expiring keys and tag invalidations plateau", async () => {
    let now = 0;
    const c = createCache(memoryStore({ maxEntries: 100_000, now: () => now }));
    const r = await leakCheck(
      "cache ttl + tags",
      async (i) => {
        now += 100;
        // Page-style keys (~80 chars), as an HTML/route cache would use.
        const key = `page:/products/category/${i}?sort=price&order=asc&filter=in-stock&lang=en-US`;
        await c.set(key, { i, name: "x" }, { ttl: 1, tags: ["pages", `t${i % 16}`] });
        await c.get(`page:/products/category/${i - 5}?sort=price&order=asc&filter=in-stock&lang=en-US`);
        if (i % 50 === 0) await c.invalidateTag(`t${(i / 50) % 16}`);
      },
      { perRound: 2000, rounds: 5 },
    );
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);
});

describe("tag indexes", () => {
  test("an index forgets keys that expired, so it stays small when the tag is never invalidated", async () => {
    let now = 0;
    const store = memoryStore({ maxEntries: 100_000, now: () => now });
    const c = createCache(store);
    for (let i = 0; i < 5000; i++) {
      now += 1000;
      await c.set(`k${i}`, i, { ttl: 2, tags: ["all"] });
    }
    const index = JSON.parse((await store.get(TAG_PREFIX + "all"))!);
    const keys: string[] = Array.isArray(index) ? index : index.k;
    // ~2 live keys; allow slack for amortized pruning.
    expect(keys.length).toBeLessThan(200);
  });

  test("an index forgets deleted keys", async () => {
    const store = memoryStore({ maxEntries: 100_000 });
    const c = createCache(store);
    for (let i = 0; i < 3000; i++) {
      await c.set(`k${i}`, i, { tags: ["all"] });
      await c.delete(`k${i}`);
    }
    const index = JSON.parse((await store.get(TAG_PREFIX + "all"))!);
    const keys: string[] = Array.isArray(index) ? index : index.k;
    expect(keys.length).toBeLessThan(200);
  });

  test("invalidateTag still removes every live key after pruning", async () => {
    let now = 0;
    const store = memoryStore({ maxEntries: 100_000, now: () => now });
    const c = createCache(store);
    for (let i = 0; i < 1000; i++) {
      now += 10;
      await c.set(`k${i}`, i, { ttl: i % 2 ? 1 : 3600, tags: ["mixed"] });
    }
    await c.invalidateTag("mixed");
    for (let i = 0; i < 1000; i++) expect(await c.get(`k${i}`)).toBeUndefined();
  });

  test("on Redis an index with only expiring keys gets a TTL, so abandoned tags do not stay forever", async () => {
    const redis = fakeRedis();
    const store = redisStore(redis.client);
    const c = createCache(store);
    await c.set("a", 1, { ttl: 30, tags: ["session:1"] });
    const indexSets = () => redis.log.filter((cmd) => cmd[0] === "SET" && cmd[1] === "miu:cache:" + TAG_PREFIX + "session:1");
    const px = (cmd: string[]) => (cmd.includes("PX") ? Number(cmd[cmd.indexOf("PX") + 1]) : undefined);
    const ttl = px(indexSets().at(-1)!);
    expect(ttl).toBeGreaterThan(30_000);
    expect(ttl).toBeLessThan(10 * 60_000);
    // A key without a TTL makes the index permanent again.
    await c.set("b", 1, { tags: ["session:1"] });
    expect(px(indexSets().at(-1)!)).toBeUndefined();
  });

  test("indexes written by older versions (plain arrays) are still read", async () => {
    const store = memoryStore();
    const c = createCache(store);
    await store.set("old", JSON.stringify(1));
    await store.set(TAG_PREFIX + "legacy", JSON.stringify(["old"]));
    await c.set("new", 2, { tags: ["legacy"] });
    await c.invalidateTag("legacy");
    expect(await c.get("old")).toBeUndefined();
    expect(await c.get("new")).toBeUndefined();
  });
});

describe("remember()", () => {
  test("in-flight entries are dropped on success and on error", async () => {
    const c = createCache(memoryStore({ maxEntries: 10 }));
    const r = await leakCheck(
      "remember",
      async (i) => {
        if (i % 2) await c.remember(`r${i}`, 60, async () => ({ i }));
        else await c.remember(`r${i}`, 60, async () => Promise.reject(new Error("boom"))).catch(() => {});
      },
      { perRound: 3000, rounds: 5 },
    );
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);
});

test("a cache with entries does not keep the process alive", async () => {
  const r = await exitCheck(
    `
    import { createCache, memoryStore } from "../src/index.ts";
    const c = createCache(memoryStore());
    await c.set("a", 1, { ttl: 3600, tags: ["t"] });
    await c.remember("b", 3600, async () => 2);
    `,
    3000,
    PKG,
  );
  expect(r.exited, r.stderr).toBe(true);
});
