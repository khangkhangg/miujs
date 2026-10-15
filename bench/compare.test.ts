import { expect, test } from "bun:test";
import { compare, metrics, type BenchResult } from "./compare.ts";

function result(over: { get?: number; users?: number; json?: number; arg?: number; coldMiu?: number; retained?: number } = {}): BenchResult {
  const row = (miujs: number) => ({ miujs, elysia: 1000, hono: 800 });
  const mem = (retained: number) => ({ retained, peak: 2048 });
  return {
    version: 1,
    throughput: {
      "GET / (text)": row(over.get ?? 900),
      "GET /users/:id (params → JSON)": row(over.users ?? 950),
      "POST /json (body validation → JSON)": row(over.json ?? 1050),
      "GET / (text), server arg": row(over.arg ?? 980),
    },
    memory: { "GET / (text)": { miujs: mem(over.retained ?? 0), elysia: mem(0), hono: mem(0) } },
    coldStartMs: { miujs: over.coldMiu ?? 10, elysia: 50, hono: 12 },
  };
}

test("metrics: throughput vs the best other framework, cold start as best other / miujs", () => {
  const m = metrics(result());
  expect(m["GET / (text)"]).toBeCloseTo(0.9);
  expect(m["POST /json (body validation → JSON)"]).toBeCloseTo(1.05);
  expect(m["cold start"]).toBeCloseTo(1.2);
});

test("passes within 5% of the baseline and fails beyond it", () => {
  const base = result();
  expect(compare(base, [result({ get: 860 })]).ok).toBe(true); // 0.86 vs 0.90: -4.4%
  const bad = compare(base, [result({ get: 850 })]); // -5.6%
  expect(bad.ok).toBe(false);
  expect(bad.rows.find((r) => r.metric === "GET / (text)")!.ok).toBe(false);
  expect(bad.rows.filter((r) => !r.ok)).toHaveLength(1);
  // Improvements always pass.
  expect(compare(base, [result({ get: 2000, users: 2000 })]).ok).toBe(true);
});

test("cold start regressions fail too (slower MiuJS start)", () => {
  expect(compare(result(), [result({ coldMiu: 10.4 })]).ok).toBe(true);
  expect(compare(result(), [result({ coldMiu: 11 })]).ok).toBe(false);
});

test("several runs: each metric keeps its best ratio (a noisy run is outvoted)", () => {
  const base = result();
  const noisy = result({ get: 700 });
  const fine = result({ get: 905, users: 700 });
  expect(compare(base, [noisy]).ok).toBe(false);
  expect(compare(base, [noisy, fine]).ok).toBe(true);
});

test("retained heap is checked against an absolute bound, not the baseline", () => {
  expect(compare(result(), [result({ retained: 30 * 1024 })]).ok).toBe(true);
  const leak = compare(result(), [result({ retained: 200 * 1024 })]);
  expect(leak.ok).toBe(false);
  expect(leak.rows.find((r) => !r.ok)!.metric).toContain("retained");
});

test("a metric missing from the current run fails; one missing from the baseline is reported only", () => {
  const cur = result();
  delete (cur.throughput as Record<string, unknown>)["GET / (text)"];
  expect(compare(result(), [cur]).ok).toBe(false);
  const base = result();
  delete (base.throughput as Record<string, unknown>)["GET / (text)"];
  const r = compare(base, [result()]);
  expect(r.ok).toBe(true);
  expect(r.rows.find((x) => x.metric === "GET / (text)")!.baseline).toBeUndefined();
});

test("a custom tolerance", () => {
  expect(compare(result(), [result({ get: 850 })], { tolerance: 0.1 }).ok).toBe(true);
});

test("medianResult: each metric from the run with its median ratio", async () => {
  const { medianResult } = await import("./compare.ts");
  const runs = [result({ get: 800, users: 1000, coldMiu: 9 }), result({ get: 900, users: 900, coldMiu: 11 }), result({ get: 1000, users: 950, coldMiu: 10 })];
  const m = metrics(medianResult(runs));
  expect(m["GET / (text)"]).toBeCloseTo(0.9);
  expect(m["GET /users/:id (params → JSON)"]).toBeCloseTo(0.95);
  expect(m["cold start"]).toBeCloseTo(1.2);
});
