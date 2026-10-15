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
});
