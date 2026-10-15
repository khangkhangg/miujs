import { afterAll, beforeAll, expect, test } from "bun:test";
import { miu } from "miujs";
import { loadtest } from "../src/loadtest.ts";
import { defineRoom, rooms, t } from "../src/index.ts";

const lobby = defineRoom("lobby", { state: t.object({ n: t.number() }), client: {}, init: () => ({ n: 0 }), on: {} });
const duo = defineRoom("duo", { state: t.object({ n: t.number() }), client: {}, init: () => ({ n: 0 }), maxPlayers: 1, on: {} });

let server: { url: string; stop(): Promise<void> };
let base = "";
beforeAll(async () => {
  server = await miu({ plugins: [rooms({ rooms: [lobby, duo] })], logLevel: "silent" }).listen(0);
  base = server.url.replace("http", "ws") + "rooms/";
});
afterAll(() => server.stop());

test("join-only runs (no actions) measure join and welcome latency", async () => {
  for (const actions of [undefined, []]) {
    const r = await loadtest({ url: base + "lobby/j1", players: 3, durationMs: 100, actions });
    expect(r.joined).toBe(3);
    expect(r.sent).toBe(0);
    expect(r.samples).toBe(0);
    expect(r.joinLatency.count).toBe(3);
    expect(r.welcomeLatency.count).toBe(3);
    expect(r.joinLatency.p50).toBeGreaterThanOrEqual(r.welcomeLatency.p50);
    expect(r.joinFailures).toEqual({});
  }
});

test("join failures are reported by error code or close reason", async () => {
  const full = await loadtest({ url: base + "duo/d1", players: 3, durationMs: 50, joinTimeoutMs: 2000 });
  expect(full.joined).toBe(1);
  expect(full.joinFailures).toEqual({ MIU_E_ROOM_FULL: 2 });

  const missing = await loadtest({ url: base + "nope/x", players: 2, durationMs: 50, joinTimeoutMs: 2000 });
  expect(missing.joined).toBe(0);
  const reasons = Object.keys(missing.joinFailures);
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).not.toBe("timeout");
  expect(missing.joinFailures[reasons[0]]).toBe(2);
});

test("players that never answer are reported as timeouts", async () => {
  // A plain HTTP server that accepts the upgrade but never sends a welcome.
  const silent = Bun.serve({ port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")), websocket: { message() {} } });
  try {
    const r = await loadtest({ url: `ws://localhost:${silent.port}/rooms/x/y`, players: 2, durationMs: 10, joinTimeoutMs: 200 });
    expect(r.joined).toBe(0);
    expect(r.joinFailures).toEqual({ timeout: 2 });
  } finally {
    silent.stop(true);
  }
});
