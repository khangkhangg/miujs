import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { memoryStore } from "../src/index.ts";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("memoryStore", () => {
  test("stores and returns JSON text", async () => {
    const s = memoryStore();
    await s.set("a", '{"x":1}');
    expect(await s.get("a")).toBe('{"x":1}');
    expect(await s.get("missing")).toBeUndefined();
    expect(s.name).toBe("memory");
  });

  test("delete removes an entry", async () => {
    const s = memoryStore();
    await s.set("a", "1");
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
  });

  test("entries expire after ttl seconds", async () => {
    const c = clock();
    const s = memoryStore({ now: c.now });
    await s.set("a", "1", { ttl: 10 });
    c.advance(9_999);
    expect(await s.get("a")).toBe("1");
    c.advance(1);
    expect(await s.get("a")).toBeUndefined();
  });

  test("evicts the least recently used entry beyond maxEntries", async () => {
    const s = memoryStore({ maxEntries: 2 });
    await s.set("a", "1");
    await s.set("b", "2");
    await s.get("a"); // a is now most recent
    await s.set("c", "3");
    expect(await s.get("b")).toBeUndefined();
    expect(await s.get("a")).toBe("1");
    expect(await s.get("c")).toBe("3");
  });

  test("size counts live entries only", async () => {
    const c = clock();
    const s = memoryStore({ now: c.now });
    await s.set("a", "1", { ttl: 1 });
    await s.set("b", "2");
    expect(s.size!()).toBe(2);
    c.advance(1_000);
    expect(s.size!()).toBe(1);
  });

  test("rejects a bad maxEntries with a MiuError", () => {
    try {
      memoryStore({ maxEntries: 0 });
      throw new Error("expected throw");
    } catch (e) {
      expect(isMiuError(e)).toBe(true);
      expect((e as any).code).toBe("MIU_E_CACHE_CONFIG");
      expect((e as any).fix).toBeTruthy();
    }
  });

  test("bytes() follows sets, overwrites, deletes, evictions and expiry", async () => {
    const c = clock();
    const s = memoryStore({ maxEntries: 2, now: c.now });
    await s.set("a", "1234");
    await s.set("a", "12");
    expect(s.bytes!()).toBe(2);
    await s.set("b", "123", { ttl: 1 });
    expect(s.bytes!()).toBe(5);
    await s.set("c", "1"); // evicts "a"
    expect(s.bytes!()).toBe(4);
    await s.delete("c");
    expect(s.bytes!()).toBe(3);
    c.advance(2000);
    expect(await s.get("b")).toBeUndefined(); // expired on read
    expect(s.bytes!()).toBe(0);
    await s.set("d", "12", { ttl: 1 });
    c.advance(2000);
    expect(s.bytes!()).toBe(0); // expired, pruned
  });

  test("scan pages in key order with a prefix and skips expired keys", async () => {
    const c = clock();
    const s = memoryStore({ now: c.now });
    await s.set("b:2", "x");
    await s.set("a:1", "xy", { ttl: 5 });
    await s.set("b:1", "x");
    await s.set("b:0", "x", { ttl: 1 });
    c.advance(1000);
    const p1 = await s.scan!({ prefix: "b:", limit: 1 });
    expect(p1).toEqual({ keys: [{ key: "b:1", bytes: 1, expiresAt: null }], next: "b:1" });
    expect(await s.scan!({ prefix: "b:", limit: 1, cursor: p1.next })).toEqual({ keys: [{ key: "b:2", bytes: 1, expiresAt: null }] });
    expect((await s.scan!({ limit: 10 })).keys[0]).toEqual({ key: "a:1", bytes: 2, expiresAt: 1_005_000 });
  });

  test("clear() empties the store and returns how many entries it had", async () => {
    const s = memoryStore();
    await s.set("a", "1");
    await s.set("b", "1");
    expect(await s.clear!()).toBe(2);
    expect(s.size!()).toBe(0);
    expect(s.bytes!()).toBe(0);
    expect(await s.get("a")).toBeUndefined();
  });
});
