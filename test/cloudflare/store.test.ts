import { describe, expect, test } from "bun:test";
import type { Store } from "../../src/batteries/store/types.ts";
import { kvStore } from "../../src/adapters/cloudflare/kv-store.ts";
import { d1Store } from "../../src/adapters/cloudflare/d1-store.ts";
import { MiuStoreObject, doStore } from "../../src/adapters/cloudflare/durable-object.ts";
import type { DurableObjectState } from "../../src/adapters/cloudflare/types.ts";
import { fakeD1, fakeDurableObjectNamespace, fakeDurableObjectState, fakeKV } from "./fakes.ts";

type Factory = (now: () => number) => Store;

/** A store object whose clock is injectable. */
const clocked = (now: () => number) =>
  class extends MiuStoreObject {
    protected override now() {
      return now();
    }
  };

const drivers: [string, Factory][] = [
  ["kv", (now) => kvStore(fakeKV(now), { now })],
  ["d1", (now) => d1Store(fakeD1(), { now })],
  [
    "durable object",
    (now) => {
      const Obj = clocked(now);
      return doStore(fakeDurableObjectNamespace((state) => new Obj(state, {})));
    },
  ],
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

describe("kvStore", () => {
  test("rounds expirationTtl up to KV's 60s minimum and records exact expiry in metadata", async () => {
    let t = 5_000;
    const kv = fakeKV(() => t);
    const store = kvStore(kv, { now: () => t });
    await store.set("short", 1, { ttl: 5 });
    await store.set("long", 1, { ttl: 120 });
    expect(kv.puts.map((p) => p.options?.expirationTtl)).toEqual([60, 120]);
    expect(kv.puts[0]!.options?.metadata).toEqual({ expires: 10_000 });
    await store.set("forever", 1);
    expect(kv.puts[2]!.options).toEqual({ metadata: { expires: null } });
  });

  test("accepts a binding getter, resolved per call", async () => {
    const kv = fakeKV();
    const store = kvStore(() => kv);
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
  });
});

describe("d1Store", () => {
  test("creates the table lazily with a custom name", async () => {
    const db = fakeD1();
    const store = d1Store(db, { table: "sessions_kv" });
    await store.set("k", 1);
    const row = db.sqlite.query("SELECT value FROM sessions_kv WHERE key = 'k'").get() as { value: string };
    expect(row.value).toBe("1");
  });

  test("rejects unsafe table names", () => {
    expect(() => d1Store(fakeD1(), { table: "x; DROP TABLE y" })).toThrow();
  });

  test("concurrent incr is atomic", async () => {
    const store = d1Store(fakeD1());
    await Promise.all(Array.from({ length: 50 }, () => store.incr("n")));
    expect(await store.get("n")).toBe(50);
  });
});

describe("durable object store", () => {
  test("concurrent incr is atomic", async () => {
    const store = doStore(fakeDurableObjectNamespace((s) => new MiuStoreObject(s, {})));
    const results = await Promise.all(Array.from({ length: 50 }, () => store.incr("n")));
    expect(new Set(results).size).toBe(50);
    expect(await store.get("n")).toBe(50);
  });

  test("routes to the named object, or a per-key name for sharding", async () => {
    const ns = fakeDurableObjectNamespace((s) => new MiuStoreObject(s, {}));
    await doStore(ns, { name: "a" }).set("k", 1);
    expect([...ns.instances.keys()]).toEqual(["a"]);
    const sharded = doStore(ns, { name: (key) => `shard-${key.length % 2}` });
    await sharded.set("x", 1);
    await sharded.set("xy", 2);
    expect([...ns.instances.keys()].sort()).toEqual(["a", "shard-0", "shard-1"]);
    expect(await sharded.get("xy")).toBe(2);
  });

  test("rejects unknown ops and non-POST requests", async () => {
    const obj = new MiuStoreObject(fakeDurableObjectState(), {});
    const bad = await obj.fetch(new Request("https://do/", { method: "POST", body: JSON.stringify({ op: "nope", args: [] }) }));
    expect(bad.status).toBe(400);
    expect((await obj.fetch(new Request("https://do/"))).status).toBe(405);
  });

  test("alarm sweeps expired keys and reschedules for the next expiry", async () => {
    let t = 1_000;
    const state: DurableObjectState & { alarm: number | null; data: Map<string, unknown> } = fakeDurableObjectState();
    const Obj = clocked(() => t);
    const obj = new Obj(state, {});
    const call = (op: string, args: unknown[]) =>
      obj.fetch(new Request("https://do/", { method: "POST", body: JSON.stringify({ op, args }) }));
    await call("set", ["a", 1, { ttl: 10 }]);
    await call("set", ["b", 1, { ttl: 100 }]);
    await call("set", ["c", 1]);
    expect(state.alarm).toBe(11_000);
    t = 11_000;
    await obj.alarm();
    expect([...state.data.keys()].sort()).toEqual(["b", "c"]);
    expect(state.alarm).toBe(101_000);
  });
});
