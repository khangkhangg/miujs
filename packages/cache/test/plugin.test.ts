import { describe, expect, test } from "bun:test";
import { miu, route, t } from "miujs";
import { cache, kvStore, memoryStore } from "../src/index.ts";
import { fakeKV } from "./fake-kv.ts";

let hits = 0;
const counter = route.get("/count/:id", {
  params: t.object({ id: t.string() }),
  handler: async ({ params, cache }) => {
    const value = await cache.remember(`count:${params.id}`, 60, async () => ({ computed: ++hits }));
    return value;
  },
});
const plain = route.get("/plain", { handler: () => ({ ok: true }) });
const bust = route.post("/bust", {
  handler: async ({ cache }) => {
    await cache.set("x", 1, { tags: ["t"] });
    await cache.invalidateTag("t");
    return { x: (await cache.get("x")) ?? null };
  },
});

const req = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method });

describe("cache() plugin", () => {
  test("decorates ctx.cache with a memory store by default, shared across requests", async () => {
    hits = 0;
    const app = miu({ routes: [counter], plugins: [cache()], logLevel: "silent" });
    expect((await app.call(counter, { params: { id: "a" } })).body).toEqual({ computed: 1 });
    expect((await app.call(counter, { params: { id: "a" } })).body).toEqual({ computed: 1 });
    expect((await app.call(counter, { params: { id: "b" } })).body).toEqual({ computed: 2 });
  });

  test("uses a configured store", async () => {
    const store = memoryStore();
    const app = miu({ routes: [bust], plugins: [cache({ store })], logLevel: "silent" });
    (await app.call(bust)).expectStatus(200);
    expect(await store.get("__miu:tag:t")).toBeUndefined();
  });

  test("kvStore(name) resolves the binding from the request env", async () => {
    hits = 0;
    const kv = fakeKV();
    const app = miu({ routes: [counter], plugins: [cache({ store: kvStore("MY_KV") })], logLevel: "silent" });
    const res = await app.dispatch(req("/count/a"), { MY_KV: kv }, { runtime: "workerd" });
    expect(await res.json()).toEqual({ computed: 1 });
    expect(JSON.parse((await kv.get("count:a"))!)).toEqual({ computed: 1 });
    expect(kv.puts[0].options?.expirationTtl).toBe(60);
  });

  test("a missing KV binding only fails requests that use the cache", async () => {
    const app = miu({ routes: [counter, plain], plugins: [cache({ store: kvStore("MY_KV") })], logLevel: "silent" });
    expect((await app.dispatch(req("/plain"), {}, { runtime: "workerd" })).status).toBe(200);
    const res = await app.dispatch(req("/count/a"), {}, { runtime: "workerd" });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_CACHE_BINDING");
  });

  test("by default on Workers, uses KV automatically when env.CACHE exists", async () => {
    hits = 0;
    const kv = fakeKV();
    const app = miu({ routes: [counter], plugins: [cache()], logLevel: "silent" });
    await app.dispatch(req("/count/z"), { CACHE: kv }, { runtime: "workerd" });
    expect(await kv.get("count:z")).toBe('{"computed":1}');
  });

  test("by default on Workers without env.CACHE, falls back to memory", async () => {
    hits = 0;
    const app = miu({ routes: [counter], plugins: [cache()], logLevel: "silent" });
    const a = await app.dispatch(req("/count/q"), {}, { runtime: "workerd" });
    const b = await app.dispatch(req("/count/q"), {}, { runtime: "workerd" });
    expect(await a.json()).toEqual({ computed: 1 });
    expect(await b.json()).toEqual({ computed: 1 });
  });

  test("off Workers, env.CACHE is ignored by default (it may be a plain env var)", async () => {
    hits = 0;
    const kv = fakeKV();
    const app = miu({ routes: [counter], plugins: [cache()], logLevel: "silent" });
    await app.dispatch(req("/count/a"), { CACHE: kv }, { runtime: "bun" });
    expect(kv.puts.length).toBe(0);
  });

  test("inspect reports the adapter and size", async () => {
    const app = miu({ routes: [counter], plugins: [cache({ store: memoryStore({ maxEntries: 50 }) })], logLevel: "silent" });
    await app.call(counter, { params: { id: "a" } });
    await app.ready();
    const info = app.inspect().plugins.find((p) => p.name === "cache")!.info as any;
    expect(info).toEqual({ adapter: "memory", size: 1, maxEntries: 50, maxBytes: 64 * 1024 * 1024 });
  });

  test("inspect for the default and for KV", () => {
    expect((cache().inspect!() as any).adapter).toBe("memory");
    expect((cache().inspect!() as any).workers).toContain("CACHE");
    expect(cache({ store: kvStore("MY_KV") }).inspect!()).toEqual({ adapter: "kv", binding: "MY_KV" });
  });

  test("cloudflare() declares the KV binding when kvStore is configured by name", () => {
    expect(cache({ store: kvStore("MY_KV") }).cloudflare!()).toEqual({ kv: ["MY_KV"] });
    expect(cache({ store: memoryStore() }).cloudflare!()).toEqual({});
  });

  test("cloudflare() declares the default CACHE namespace, so Workers don't fall back to per-isolate memory", () => {
    // Regression (workerd harness): without it, `miu deploy cloudflare` wrote no KV binding and every
    // isolate cached in its own memory: a delete on one isolate left stale entries on the others.
    expect(cache().cloudflare!()).toEqual({ kv: ["CACHE"] });
  });
});
