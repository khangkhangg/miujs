import { describe, expect, test } from "bun:test";
import { validate } from "miujs";
import { cache, createCache, kvStore, memoryStore, redisStore } from "../src/index.ts";
import { PURGE_BATCH } from "../src/manage.ts";
import { fakeKV } from "./fake-kv.ts";
import { fakeRedis } from "./fake-redis.ts";
import { actionOf, checkContract, listOf, manageCtx, run, section, stat } from "./manage-helpers.ts";


describe("cache manage()", () => {
  test("has one valid 'cache' section", () => {
    const sections = cache().manage!();
    checkContract(sections);
    expect(sections.map((s) => s.id)).toEqual(["cache"]);
  });

  test("status shows the store, entries, bytes and this instance's hit rate", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    const c = createCache(store);
    await c.set("a", "hello");
    await c.get("a");
    await c.get("a");
    await c.get("missing");
    const { stats } = await section(plugin, "cache").status!(ctx);
    expect(stat(stats, "Store")?.value).toBe("memory");
    expect(stat(stats, "Entries")?.value).toBe(1);
    expect(stat(stats, "Size")?.value).toBe(JSON.stringify("hello").length);
    expect(stat(stats, "Hits")?.value).toBe(2);
    expect(stat(stats, "Misses")?.value).toBe(1);
    expect(stat(stats, "Hit rate")?.value).toBe("67%");
  });

  test("remember() counts hits and misses too", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    const c = createCache(store);
    await c.remember("r", 60, () => 1);
    await c.remember("r", 60, () => 1);
    const { stats } = await section(plugin, "cache").status!(ctx);
    expect(stat(stats, "Hits")?.value).toBe(1);
    expect(stat(stats, "Misses")?.value).toBe(1);
  });

  test("status on a KV store says entries are not countable instead of faking a number", async () => {
    const kv = fakeKV();
    const plugin = cache({ store: kvStore("MY_KV") });
    const ctx = await manageCtx(plugin, { MY_KV: kv }, "workerd");
    const { stats } = await section(plugin, "cache").status!(ctx);
    expect(stat(stats, "Store")?.value).toBe("kv");
    const entries = stat(stats, "Entries") as { value: unknown; hint?: string };
    expect(entries.value).toBeNull();
    expect(entries.hint).toMatch(/not countable/i);
    expect(stat(stats, "Hit rate")?.value).toBe("n/a");
  });

  test("status uses the KV binding env.CACHE on Workers by default", async () => {
    const plugin = cache();
    const ctx = await manageCtx(plugin, { CACHE: fakeKV() }, "workerd");
    const { stats } = await section(plugin, "cache").status!(ctx);
    expect(stat(stats, "Store")?.value).toBe("kv");
  });

  test("deleteKey removes one key and is idempotent", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    await store.set("k", "1");
    const del = actionOf(section(plugin, "cache"), "deleteKey");
    expect(await run(del, { key: "k" }, ctx)).toMatch(/Deleted/);
    expect(await store.get("k")).toBeUndefined();
    expect(await run(del, { key: "k" }, ctx)).toMatch(/Deleted/);
    expect(validate(del.input!, { key: "" }).ok).toBe(false);
    expect(validate(del.input!, {}).ok).toBe(false);
  });

  test("invalidateTag deletes the tagged keys", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    const c = createCache(store);
    await c.set("a", 1, { tags: ["users"] });
    await c.set("b", 2);
    const inv = actionOf(section(plugin, "cache"), "invalidateTag");
    expect(await run(inv, { tag: "users" }, ctx)).toMatch(/users/);
    expect(await c.get("a")).toBeUndefined();
    expect(await c.get("b")).toBe(2);
    expect(validate(inv.input!, { tag: "" }).ok).toBe(false);
  });

  test("purgePrefix deletes only matching keys and is marked dangerous", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    await store.set("user:1", "1");
    await store.set("user:2", "2");
    await store.set("post:1", "3");
    const purge = actionOf(section(plugin, "cache"), "purgePrefix");
    expect(purge.danger).toBe(true);
    expect(await run(purge, { prefix: "user:" }, ctx)).toBe('Deleted 2 keys starting with "user:".');
    expect(await store.get("user:1")).toBeUndefined();
    expect(await store.get("post:1")).toBe("3");
    expect(validate(purge.input!, { prefix: "" }).ok).toBe(false);
  });

  test("purgePrefix works on KV bindings that can list, in bounded batches", async () => {
    const kv = listableKV();
    for (let i = 0; i < 5; i++) await kv.put(`p:${i}`, "x");
    await kv.put("other", "x");
    const plugin = cache({ store: kvStore("MY_KV") });
    const ctx = await manageCtx(plugin, { MY_KV: kv }, "workerd");
    const purge = actionOf(section(plugin, "cache"), "purgePrefix");
    expect(await run(purge, { prefix: "p:" }, ctx)).toBe('Deleted 5 keys starting with "p:".');
    expect([...kv.data.keys()]).toEqual(["other"]);
  });

  test("purgeAll clears a memory store", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    await store.set("a", "1");
    await store.set("b", "2");
    const all = actionOf(section(plugin, "cache"), "purgeAll");
    expect(all.danger).toBe(true);
    expect(await run(all, {}, ctx)).toBe("Deleted 2 keys.");
    expect(store.size!()).toBe(0);
    expect(await run(all, {}, ctx)).toBe("Deleted 0 keys.");
  });

  test("purge actions explain when the store cannot enumerate keys", async () => {
    const kv = fakeKV(); // no list()
    const plugin = cache({ store: kvStore("MY_KV") });
    const ctx = await manageCtx(plugin, { MY_KV: kv }, "workerd");
    const s = section(plugin, "cache");
    await expect(run(actionOf(s, "purgeAll"), {}, ctx)).rejects.toThrow(/cannot list/);
    await expect(run(actionOf(s, "purgePrefix"), { prefix: "a" }, ctx)).rejects.toThrow(/cannot list/);
  });

  test("keys list pages through a memory store without values", async () => {
    let t = 1_000_000;
    const store = memoryStore({ now: () => t });
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    await store.set("a", '"secret-value"', { ttl: 10 });
    await store.set("b", "2");
    await store.set("c", "3");
    const keys = listOf(section(plugin, "cache"), "keys");
    const p1 = await keys.list({ limit: 2 }, ctx);
    expect(p1.rows).toEqual([
      { key: "a", bytes: 14, expiresAt: new Date(1_010_000).toISOString() },
      { key: "b", bytes: 1, expiresAt: null },
    ]);
    expect(JSON.stringify(p1)).not.toContain("secret-value");
    expect(p1.next).toBeString();
    const p2 = await keys.list({ limit: 2, cursor: p1.next }, ctx);
    expect(p2.rows.map((r) => r.key)).toEqual(["c"]);
    expect(p2.next).toBeUndefined();
    const searched = await keys.list({ limit: 10, search: "b" }, ctx);
    expect(searched.rows.map((r) => r.key)).toEqual(["b"]);
    t += 20_000; // "a" expired
    expect((await keys.list({ limit: 10 }, ctx)).rows.map((r) => r.key)).toEqual(["b", "c"]);
  });

  test("keys list has a delete row action", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    await store.set("a", "1");
    const del = actionOf(listOf(section(plugin, "cache"), "keys"), "delete");
    expect(await run(del, { id: "a" }, ctx)).toMatch(/Deleted/);
    expect(await store.get("a")).toBeUndefined();
  });

  test("keys list on KV uses list() when the binding has it, and explains when it cannot", async () => {
    const kv = listableKV();
    await kv.put("x", "1");
    const plugin = cache({ store: kvStore("MY_KV") });
    const keys = listOf(section(plugin, "cache"), "keys");
    const ctx = await manageCtx(plugin, { MY_KV: kv }, "workerd");
    expect((await keys.list({ limit: 10 }, ctx)).rows).toEqual([{ key: "x", bytes: null, expiresAt: null }]);
    const ctx2 = await manageCtx(plugin, { MY_KV: fakeKV() }, "workerd");
    await expect(keys.list({ limit: 10 }, ctx2)).rejects.toThrow(/cannot list/);
  });

  test("the keys list caps the page size", async () => {
    const store = memoryStore();
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    for (let i = 0; i < 150; i++) await store.set(`k${i}`, "1");
    const keys = listOf(section(plugin, "cache"), "keys");
    expect((await keys.list({ limit: 1000 }, ctx)).rows.length).toBe(100);
  });
});

/** fakeKV plus Cloudflare's list({ prefix, cursor, limit }). */
function listableKV() {
  const kv = fakeKV();
  return Object.assign(kv, {
    async list(o: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const all = [...kv.data.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 1000;
      const page = all.slice(start, start + limit);
      const done = start + limit >= all.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  });
}


describe("cache manage() purge limits", () => {
  test("purgePrefix stops after PURGE_BATCH keys and says more remain", async () => {
    const store = memoryStore({ maxEntries: 2000 });
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    for (let i = 0; i < PURGE_BATCH + 5; i++) await store.set(`k${i}`, "1");
    const purge = actionOf(section(plugin, "cache"), "purgePrefix");
    expect(await run(purge, { prefix: "k" }, ctx)).toBe(`Deleted ${PURGE_BATCH} keys starting with "k". More remain: run again.`);
    expect(store.size!()).toBe(5);
    expect(await run(purge, { prefix: "k" }, ctx)).toBe('Deleted 5 keys starting with "k".');
  });

  test("purgeAll on a listable KV deletes through scan", async () => {
    const kv = listableKV();
    await kv.put("a", "1");
    await kv.put("b", "1");
    const plugin = cache({ store: kvStore("MY_KV") });
    const ctx = await manageCtx(plugin, { MY_KV: kv }, "workerd");
    expect(await run(actionOf(section(plugin, "cache"), "purgeAll"), {}, ctx)).toBe("Deleted 2 keys.");
    expect(kv.data.size).toBe(0);
  });

  test("KV scan converts list() expirations (seconds) to ms", async () => {
    const kv = listableKV();
    const orig = kv.list;
    kv.list = async (o) => ({ ...(await orig(o)), keys: [{ name: "e", expiration: 2_000_000_000 }] });
    const plugin = cache({ store: kvStore(kv) });
    const ctx = await manageCtx(plugin);
    const rows = (await listOf(section(plugin, "cache"), "keys").list({ limit: 5 }, ctx)).rows;
    expect(rows).toEqual([{ key: "e", bytes: null, expiresAt: new Date(2_000_000_000_000).toISOString() }]);
  });
});

test("purgeAll clears a large memory store in one run", async () => {
  const store = memoryStore({ maxEntries: 2000 });
  const plugin = cache({ store });
  const ctx = await manageCtx(plugin);
  for (let i = 0; i < PURGE_BATCH + 5; i++) await store.set(`k${i}`, "1");
  expect(await run(actionOf(section(plugin, "cache"), "purgeAll"), {}, ctx)).toBe(`Deleted ${PURGE_BATCH + 5} keys.`);
});

describe("cache manage() on Redis", () => {
  test("lists keys, purges by prefix and purges everything, leaving other prefixes alone", async () => {
    const r = fakeRedis();
    const store = redisStore(r.client, { prefix: "app:" });
    await r.client.set("other:x", "1");
    for (const k of ["user:1", "user:2", "post:1"]) await store.set(k, "1");
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    const s = section(plugin, "cache");
    const rows = (await listOf(s, "keys").list({ limit: 10, search: "user:" }, ctx)).rows;
    expect(rows.map((x) => x.key).sort()).toEqual(["user:1", "user:2"]);
    expect(await run(actionOf(s, "purgePrefix"), { prefix: "user:" }, ctx)).toBe('Deleted 2 keys starting with "user:".');
    expect(r.keys().sort()).toEqual(["app:post:1", "other:x"]);
    expect(await run(actionOf(s, "purgeAll"), {}, ctx)).toBe("Deleted 1 key.");
    expect(r.keys()).toEqual(["other:x"]);
  });

  test("purgePrefix on Redis stops after PURGE_BATCH keys and finishes on the next run", async () => {
    const r = fakeRedis();
    const store = redisStore(r.client);
    for (let i = 0; i < PURGE_BATCH + 5; i++) await store.set(`k${i}`, "1");
    const plugin = cache({ store });
    const ctx = await manageCtx(plugin);
    const purge = actionOf(section(plugin, "cache"), "purgePrefix");
    expect(await run(purge, { prefix: "k" }, ctx)).toBe(`Deleted ${PURGE_BATCH} keys starting with "k". More remain: run again.`);
    expect(r.keys().length).toBe(5);
    expect(await run(purge, { prefix: "k" }, ctx)).toBe('Deleted 5 keys starting with "k".');
  });

  test("a Redis client without scan: the keys list and purges say they cannot list", async () => {
    const { scan: _scan, ...client } = fakeRedis().client;
    const plugin = cache({ store: redisStore(client) });
    const ctx = await manageCtx(plugin);
    const s = section(plugin, "cache");
    await expect(listOf(s, "keys").list({ limit: 10 }, ctx)).rejects.toThrow(/cannot list/);
    await expect(Promise.resolve().then(() => run(actionOf(s, "purgePrefix"), { prefix: "a" }, ctx))).rejects.toThrow(/cannot list/);
  });
});
