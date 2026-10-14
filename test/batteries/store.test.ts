import { describe, expect, test } from "bun:test";
import { memoryStore, sqliteStore, type Store } from "../../src/batteries/store/index.ts";

type Factory = (now: () => number) => Store;

const drivers: [string, Factory][] = [
  ["memory", (now) => memoryStore({ now })],
  ["sqlite", (now) => sqliteStore({ path: ":memory:", now })],
];

for (const [name, make] of drivers) {
  describe(`Store contract: ${name}`, () => {
    const setup = () => {
      let t = 1_000_000;
      const clock = { advance: (ms: number) => (t += ms) };
      return { store: make(() => t), clock };
    };

    test("get on a missing key is undefined", async () => {
      const { store } = setup();
      expect(await store.get("nope")).toBeUndefined();
    });

    test("round-trips JSON values", async () => {
      const { store } = setup();
      await store.set("obj", { a: 1, b: [true, "x"], c: null });
      await store.set("num", 42);
      await store.set("str", "hello");
      expect(await store.get("obj")).toEqual({ a: 1, b: [true, "x"], c: null });
      expect(await store.get<number>("num")).toBe(42);
      expect(await store.get("str")).toBe("hello");
    });

    test("set overwrites", async () => {
      const { store } = setup();
      await store.set("k", 1);
      await store.set("k", 2);
      expect(await store.get("k")).toBe(2);
    });

    test("delete removes and reports whether the key existed", async () => {
      const { store } = setup();
      await store.set("k", 1);
      expect(await store.delete("k")).toBe(true);
      expect(await store.delete("k")).toBe(false);
      expect(await store.has("k")).toBe(false);
    });

    test("ttl expires values", async () => {
      const { store, clock } = setup();
      await store.set("k", "v", { ttl: 10 });
      clock.advance(9_999);
      expect(await store.get("k")).toBe("v");
      clock.advance(1);
      expect(await store.get("k")).toBeUndefined();
      expect(await store.has("k")).toBe(false);
    });

    test("set without ttl clears a previous ttl", async () => {
      const { store, clock } = setup();
      await store.set("k", 1, { ttl: 1 });
      await store.set("k", 2);
      clock.advance(5_000);
      expect(await store.get("k")).toBe(2);
    });

    test("incr creates, increments and returns the new value", async () => {
      const { store } = setup();
      expect(await store.incr("c")).toBe(1);
      expect(await store.incr("c")).toBe(2);
      expect(await store.incr("c", 5)).toBe(7);
      expect(await store.get("c")).toBe(7);
    });

    test("incr ttl applies only when the counter is created", async () => {
      const { store, clock } = setup();
      await store.incr("c", 1, { ttl: 10 });
      clock.advance(6_000);
      await store.incr("c", 1, { ttl: 10 }); // must not extend the window
      clock.advance(4_000);
      expect(await store.get("c")).toBeUndefined();
      expect(await store.incr("c", 1, { ttl: 10 })).toBe(1);
    });

    test("ttl returns remaining seconds, -1 without expiry, undefined when missing", async () => {
      const { store, clock } = setup();
      await store.set("a", 1, { ttl: 60 });
      await store.set("b", 1);
      clock.advance(15_500);
      expect(await store.ttl("a")).toBe(45);
      expect(await store.ttl("b")).toBe(-1);
      expect(await store.ttl("zzz")).toBeUndefined();
    });

    test("keys are isolated with prefix()", async () => {
      const { store } = setup();
      const a = store.prefix("a:");
      const b = store.prefix("b:");
      await a.set("x", 1);
      await b.set("x", 2);
      expect(await a.get("x")).toBe(1);
      expect(await b.get("x")).toBe(2);
      expect(await store.get("a:x")).toBe(1);
    });
  });
}

test("sqlite store persists to a file", async () => {
  const path = `/tmp/miu-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  const s1 = sqliteStore({ path });
  await s1.set("k", { v: 1 });
  await s1.close();
  const s2 = sqliteStore({ path });
  expect(await s2.get("k")).toEqual({ v: 1 });
  await s2.close();
});
