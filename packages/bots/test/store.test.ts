import { describe, expect, test } from "bun:test";
import type { Context } from "miujs";
import { createCache, memoryStore as cacheMemoryStore } from "../../cache/src/index.ts";
import { cacheApiStore, cacheClientStore, memoryBotStore, type CachedResponse } from "../src/index.ts";

const T0 = 1_000_000_000;
const entry = (body: string, o: Partial<CachedResponse> = {}): CachedResponse => ({
  status: 200,
  headers: [["content-type", "application/json"]],
  body: new TextEncoder().encode(body),
  storedAt: T0,
  expires: T0 + 60_000,
  staleUntil: T0 + 60_000,
  ...o,
});
const text = (e: CachedResponse | undefined) => (e ? new TextDecoder().decode(e.body) : undefined);

describe("memoryBotStore", () => {
  test("stores and returns entries until staleUntil", async () => {
    let now = T0;
    const s = memoryBotStore({ now: () => now });
    await s.set("k", entry('{"a":1}'));
    expect(text(await s.get("k"))).toBe('{"a":1}');
    now = T0 + 60_001;
    expect(await s.get("k")).toBeUndefined();
    expect(s.size!()).toBe(0);
  });

  test("is bounded by entries, evicting the least recently used", async () => {
    const s = memoryBotStore({ maxEntries: 3, now: () => T0 });
    for (const k of ["a", "b", "c"]) await s.set(k, entry(k));
    await s.get("a"); // a is now most recent
    await s.set("d", entry("d"));
    expect(s.size!()).toBe(3);
    expect(await s.get("b")).toBeUndefined();
    expect(text(await s.get("a"))).toBe("a");
  });

  test("is bounded by bytes", async () => {
    const s = memoryBotStore({ maxBytes: 10_000, now: () => T0 });
    for (let i = 0; i < 100; i++) await s.set(`k${i}`, entry("x".repeat(1000)));
    expect(s.inspect!().bytes as number).toBeLessThanOrEqual(10_000);
    expect(s.size!()).toBeLessThan(10);
    expect(text(await s.get("k99"))).toHaveLength(1000);
  });

  test("an entry larger than maxBytes is not stored", async () => {
    const s = memoryBotStore({ maxBytes: 1000, now: () => T0 });
    await s.set("big", entry("x".repeat(5000)));
    expect(await s.get("big")).toBeUndefined();
  });

  test("replacing a key keeps the byte count right", async () => {
    const s = memoryBotStore({ now: () => T0 });
    await s.set("k", entry("x".repeat(1000)));
    const one = s.inspect!().bytes as number;
    await s.set("k", entry("x".repeat(1000)));
    expect(s.inspect!().bytes).toBe(one);
  });
});

describe("cacheClientStore (ctx.cache from @miujs/cache)", () => {
  test("round-trips an entry, binary body included", async () => {
    const ctx = { cache: createCache(cacheMemoryStore()) } as unknown as Context;
    const s = cacheClientStore({ now: () => T0 });
    const bytes = new Uint8Array(300).map((_, i) => i % 256);
    await s.set("k", entry("", { body: bytes }), ctx);
    const got = await s.get("k", ctx);
    expect(got?.status).toBe(200);
    expect(got?.headers).toEqual([["content-type", "application/json"]]);
    expect([...got!.body]).toEqual([...bytes]);
    expect(got?.staleUntil).toBe(T0 + 60_000);
  });

  test("long keys are hashed to fit KV's 512-byte key limit", async () => {
    const seen: string[] = [];
    const inner = cacheMemoryStore();
    const ctx = { cache: createCache({ ...inner, name: "spy", set: (k, v, o) => (seen.push(k), inner.set(k, v, o)), get: inner.get, delete: inner.delete }) } as unknown as Context;
    const s = cacheClientStore({ now: () => T0 });
    const key = `GET:example.com/${"a".repeat(2000)}`;
    await s.set(key, entry("x"), ctx);
    expect(seen[0].length).toBeLessThanOrEqual(512);
    expect(text(await s.get(key, ctx))).toBe("x");
  });
});

describe("cacheApiStore (Workers caches.default)", () => {
  // The Cache API's contract: match()/put() keyed by URL. A Map is a faithful in-memory version.
  function fakeCache() {
    const m = new Map<string, Response>();
    return {
      m,
      async match(r: Request | string) {
        const x = m.get(typeof r === "string" ? r : r.url);
        return x?.clone();
      },
      async put(r: Request | string, res: Response) {
        m.set(typeof r === "string" ? r : r.url, res);
      },
      async delete(r: Request | string) {
        return m.delete(typeof r === "string" ? r : r.url);
      },
    };
  }

  test("round-trips an entry with its timing", async () => {
    const cache = fakeCache();
    const s = cacheApiStore({ cache, now: () => T0 });
    await s.set("GET:x/a", entry('{"a":1}'));
    const got = await s.get("GET:x/a");
    expect(text(got)).toBe('{"a":1}');
    expect(got?.headers).toEqual([["content-type", "application/json"]]);
    expect(got?.expires).toBe(T0 + 60_000);
    const stored = [...cache.m.values()][0];
    expect(stored.headers.get("cache-control")).toBe("public, max-age=60");
  });
});
