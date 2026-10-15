// Memory and CPU health of rate limiting: expired windows are pruned, the key bound holds under
// a flood of distinct keys without O(n) work per request, and a flood cannot evict a blocked key.
import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { describeLeak, leakCheck } from "../../../scripts/lib/leak.ts";
import { memoryStore, rateLimit, type Policy } from "../src/index.ts";

const S = 1000;
const T0 = 1_000 * 60 * S;
const report = (r: { name: string }) => process.env.LEAK_REPORT && console.log(describeLeak(r as never));
const keysOf = (s: ReturnType<typeof memoryStore>) => s.inspect!().keys as number;
const fixed = (limit: number, windowMs: number): Policy => ({ algorithm: "fixed", limit, windowMs, cost: 1 });

describe("memoryStore", () => {
  for (const algorithm of ["fixed", "sliding", "token-bucket"] as const) {
    test(`${algorithm}: expired windows are pruned without waiting for the store to fill up`, async () => {
      const store = memoryStore();
      const policy: Policy = { algorithm, limit: 5, windowMs: 10 * S, cost: 1 };
      let now = T0;
      for (let i = 0; i < 10_000; i++) {
        now += S;
        await store.consume(`ip:${i}`, policy, now);
      }
      // ~20 keys are live (a key lives one or two windows); allow slack for amortized sweeps.
      expect(keysOf(store)).toBeLessThan(2_000);
    });
  }

  test("a flood of distinct keys cannot evict a blocked key", async () => {
    const store = memoryStore({ maxKeys: 100 });
    const p = fixed(3, 3600 * S);
    for (let i = 0; i < 3; i++) expect((await store.consume("login:victim@example.com", p, T0)).allowed).toBe(true);
    expect((await store.consume("login:victim@example.com", p, T0)).allowed).toBe(false);
    for (let i = 0; i < 5_000; i++) await store.consume(`login:junk${i}@example.com`, p, T0 + i);
    expect(keysOf(store)).toBeLessThanOrEqual(100);
    expect((await store.consume("login:victim@example.com", p, T0 + 6_000)).allowed).toBe(false);
  });

  test("a full store does not scan every key on each new key", async () => {
    const store = memoryStore({ maxKeys: 20_000 });
    const p = fixed(10, 3600 * S);
    for (let i = 0; i < 20_000; i++) await store.consume(`fill${i}`, p, T0);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) await store.consume(`flood${i}`, p, T0);
    const ms = performance.now() - started;
    expect(keysOf(store)).toBeLessThanOrEqual(20_000);
    // Before: one 20k-key scan per new key (~4e8 steps, seconds). Now: amortized batches.
    expect(ms).toBeLessThan(1_000);
  });

  test("distinct keys in one window plateau at maxKeys", async () => {
    const store = memoryStore({ maxKeys: 1_000 });
    const p = fixed(10, 3600 * S);
    const r = await leakCheck("flood", (i) => store.consume(`k${i}`, p, T0), { perRound: 3000, rounds: 5 });
    report(r);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);
});

test("many clients through app.fetch with a moving clock plateau", async () => {
  let now = T0;
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [
      rateLimit({
        now: () => now,
        trustProxyHeader: "x-real-ip",
        rules: [
          { name: "api", match: { path: "/api/*" }, limit: 100, window: "1m" },
          { name: "burst", match: { path: "/api/*" }, limit: 10, window: "10s", algorithm: "token-bucket" },
        ],
      }),
    ],
    routes: [route.get("/api/items", { handler: () => ({ ok: true }) })],
  });
  await app.ready();
  const r = await leakCheck(
    "ratelimit app",
    async (i) => {
      now += 50;
      const res = await app.fetch(new Request("http://localhost/api/items", { headers: { "x-real-ip": `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` } }));
      await res.arrayBuffer();
    },
    { perRound: 3000, rounds: 5, warmup: 3000 },
  );
  report(r);
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 60_000);
