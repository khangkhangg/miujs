import { expect, test } from "bun:test";
import { exitCheck, leakCheck, openHandles } from "../lib/leak.ts";

const sink: unknown[] = [];

test("flags a function that keeps every allocation alive", async () => {
  const r = await leakCheck("leaky", () => void sink.push({ big: new Array(16).fill(1) }), { perRound: 2000, rounds: 4 });
  expect(r.leaking).toBe(true);
  expect(r.bytesPerIteration).toBeGreaterThan(64);
});

test("passes a function whose allocations are collectable", async () => {
  const r = await leakCheck("clean", () => ({ big: new Array(16).fill(1) }), { perRound: 2000, rounds: 4 });
  expect(r.leaking).toBe(false);
});

test("detects a process kept alive by a timer, and passes one that exits", async () => {
  expect((await exitCheck("setInterval(() => {}, 1000);", 1500)).exited).toBe(false);
  expect((await exitCheck("const t = setInterval(() => {}, 1000); t.unref?.();", 3000)).exited).toBe(true);
});

test("flags a small per-iteration Map entry (the typical cache-without-eviction leak)", async () => {
  const cache = new Map<string, number>();
  const r = await leakCheck("map", (i) => void cache.set(`k${i}`, i), { perRound: 5000, rounds: 4 });
  expect(r.leaking).toBe(true);
});

test("tolerates Bun's one-time JIT Structure objects in short runs", async () => {
  // Fresh object shapes on each call (new keys) create Structures until the JIT settles; a
  // bounded number of them must not count as a leak.
  const shapes = Array.from({ length: 300 }, (_, i) => `k${i}`);
  const r = await leakCheck("shapes", (i) => ({ [shapes[i % 300]]: i }), { perRound: 1000, rounds: 4, warmup: 0 });
  expect(r.leaking).toBe(false);
});

test("openHandles reports a number on Linux and Windows", () => {
  const n = openHandles();
  if (process.platform === "linux" || process.platform === "win32") expect(n).toBeGreaterThan(0);
  else expect(n).toBeNull();
});
