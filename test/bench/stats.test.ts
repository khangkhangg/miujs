import { expect, test } from "bun:test";
import { Histogram, pickWeighted } from "../../bench/lib/stats.ts";

test("histogram percentiles are accurate to ~1% for latency-shaped data", () => {
  const h = new Histogram();
  for (let i = 1; i <= 10_000; i++) h.record(i / 100); // 0.01ms .. 100ms uniform
  expect(h.count).toBe(10_000);
  expect(h.percentile(50)).toBeCloseTo(50, -0.3);
  expect(Math.abs(h.percentile(99) - 99) / 99).toBeLessThan(0.02);
  expect(h.max).toBe(100);
  expect(h.mean).toBeCloseTo(50.005, 1);
});

test("histograms merge (workers report separately)", () => {
  const a = new Histogram();
  const b = new Histogram();
  for (let i = 0; i < 100; i++) a.record(1);
  for (let i = 0; i < 100; i++) b.record(10);
  const m = Histogram.fromJSON(a.toJSON());
  m.merge(Histogram.fromJSON(b.toJSON()));
  expect(m.count).toBe(200);
  expect(m.percentile(25)).toBeCloseTo(1, 1);
  expect(m.percentile(75)).toBeCloseTo(10, 0);
});

test("weighted pick follows weights", () => {
  const items = [{ w: 1, n: "a" }, { w: 3, n: "b" }];
  const counts = { a: 0, b: 0 } as Record<string, number>;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40_000; i++) counts[pickWeighted(items, (x) => x.w, rnd).n]!++;
  expect(counts.b! / counts.a!).toBeGreaterThan(2.8);
  expect(counts.b! / counts.a!).toBeLessThan(3.2);
});
