import { afterAll, beforeAll, expect, test } from "bun:test";
import { miu } from "miujs";
import { loadtest, percentile, summarize } from "../src/loadtest.ts";
import { defineRoom, rooms, t } from "../src/index.ts";

test("percentile uses nearest rank on sorted samples", () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  expect(percentile(xs, 50)).toBe(50);
  expect(percentile(xs, 95)).toBe(95);
  expect(percentile(xs, 99)).toBe(99);
  expect(percentile(xs, 100)).toBe(100);
  expect(percentile([7], 99)).toBe(7);
  expect(percentile([], 50)).toBe(0);
});

test("summarize reports count, min, max, mean and p50/p95/p99", () => {
  expect(summarize([30, 10, 20, 40])).toEqual({ count: 4, min: 10, max: 40, mean: 25, p50: 20, p95: 40, p99: 40 });
  expect(summarize([])).toEqual({ count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 });
});

// ---- against a real local Bun room ---------------------------------------------------------

const counter = defineRoom("counter", {
  state: t.object({ n: t.number() }),
  client: { inc: t.object({ by: t.number() }), bad: t.object({}) },
  init: () => ({ n: 0 }),
  on: {
    inc: ({ room, msg }) => {
      room.state.n += msg.by;
    },
  },
});

let server: { url: string; stop(): Promise<void> };
let base = "";
beforeAll(async () => {
  server = await miu({ plugins: [rooms({ rooms: [counter] })], logLevel: "silent" }).listen(0);
  base = server.url.replace("http", "ws") + "rooms/counter/";
});
afterAll(() => server.stop());

test("loadtest simulates N clients and reports state-patch latency after actions", async () => {
  const report = await loadtest({ url: base + "L1", players: 4, durationMs: 300, ratePerSecond: 20, actions: [{ type: "inc", data: { by: 1 } }] });
  expect(report.players).toBe(4);
  expect(report.joined).toBe(4);
  expect(report.sent).toBeGreaterThan(4);
  expect(report.samples).toBeGreaterThan(0);
  expect(report.errors).toBe(0);
  const l = report.latency;
  expect(l.p50).toBeGreaterThanOrEqual(0);
  expect(l.p95).toBeGreaterThanOrEqual(l.p50);
  expect(l.p99).toBeGreaterThanOrEqual(l.p95);
  expect(l.max).toBeGreaterThanOrEqual(l.p99);
});

test("actions can be a function per player; error frames are counted by code", async () => {
  const report = await loadtest({
    url: base + "L2",
    players: 2,
    durationMs: 150,
    ratePerSecond: 20,
    actions: ({ player, n }) => (player === 1 && n === 0 ? { type: "bad" } : { type: "inc", data: { by: player + 1 } }),
  });
  expect(report.errorCodes).toEqual({});
  expect(report.sent).toBeGreaterThan(2);
  const bogus = await loadtest({ url: base + "L3", players: 1, durationMs: 100, ratePerSecond: 20, actions: [{ type: "nope" }] });
  expect(bogus.errorCodes.MIU_E_ROOM_UNKNOWN_MESSAGE).toBeGreaterThan(0);
  expect(bogus.errors).toBe(bogus.errorCodes.MIU_E_ROOM_UNKNOWN_MESSAGE);
});
