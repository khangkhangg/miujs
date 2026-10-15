import { describe, expect, test } from "bun:test";
import { createCache, kvStore } from "../src/index.ts";
import { fakeKV } from "./fake-kv.ts";

describe("kvStore", () => {
  test("reads and writes through a KV binding", async () => {
    const kv = fakeKV();
    const s = kvStore(kv);
    expect(s.name).toBe("kv");
    await s.set("a", "1");
    expect(await s.get("a")).toBe("1");
    expect(await s.get("missing")).toBeUndefined();
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
  });

  test("passes ttl as expirationTtl and clamps to KV's 60s minimum", async () => {
    const kv = fakeKV();
    const s = kvStore(kv);
    await s.set("short", "1", { ttl: 5 });
    await s.set("long", "1", { ttl: 120 });
    await s.set("forever", "1");
    expect(kv.puts.map((p) => p.options?.expirationTtl)).toEqual([60, 120, undefined]);
  });

  test("rounds fractional ttls up to whole seconds", async () => {
    const kv = fakeKV();
    await kvStore(kv).set("a", "1", { ttl: 90.2 });
    expect(kv.puts[0].options?.expirationTtl).toBe(91);
  });

  test("a binding name resolves from env per request", async () => {
    const kv = fakeKV();
    const s = kvStore("MY_KV");
    const bound = s.forEnv!({ MY_KV: kv });
    await bound.set("a", "1");
    expect(await kv.get("a")).toBe("1");
    expect(s.forEnv!({ MY_KV: kv })).toBe(bound); // reused per binding
  });

  test("a missing binding throws MIU_E_CACHE_BINDING when used", async () => {
    const s = kvStore("NOPE");
    try {
      s.forEnv!({});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as any).code).toBe("MIU_E_CACHE_BINDING");
      expect((e as any).fix).toContain("NOPE");
    }
    await expect(s.get("a")).rejects.toMatchObject({ code: "MIU_E_CACHE_BINDING" });
  });

  test("works under createCache, including tags", async () => {
    const c = createCache(kvStore(fakeKV()));
    await c.set("a", { x: 1 }, { tags: ["t"], ttl: 10 });
    expect(await c.get("a")).toEqual({ x: 1 });
    await c.invalidateTag("t");
    expect(await c.get("a")).toBeUndefined();
  });
});
