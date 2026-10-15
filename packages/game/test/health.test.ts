// Memory and exit health of the game package: matchmaker cycles, lobbies, leaderboards, result
// sinks and fixedStep loops. Each leak check runs many iterations with forced GC and fails if live
// memory keeps growing after warm-up.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { FakeClock, RoomInstance, defineRoom, rooms, t } from "@miujs/realtime";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { leaderboard, signScoreProof } from "../src/leaderboard.ts";
import { lobbies } from "../src/lobbies.ts";
import { fixedStep } from "../src/loop.ts";
import { matchmaker } from "../src/matchmaker.ts";
import { QueueCore } from "../src/queue.ts";
import { gameRoom } from "../src/room.ts";
import { issueTicket } from "../src/sign.ts";
import { as, settle, testAuth } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");
const SECRET = "health-secret-0123456789abcdef";

function gameApp() {
  const clock = new FakeClock(10_000);
  const db = sqlite(":memory:");
  const arena = gameRoom("arena", { state: t.object({ ok: t.boolean() }), init: () => ({ ok: true }) }, { secret: SECRET });
  const realtime = rooms({ rooms: [arena], clock, emptyMs: 1_000 });
  const mm = matchmaker({ rooms: realtime, secret: SECRET, database: db, clock, queues: { ranked: { room: "arena", teamSize: 1, rating: "elo", widenAfterMs: 1_000, maxWaitMs: 10_000, statusTtlMs: 5_000 } } });
  const party = lobbies({ rooms: realtime, room: "arena", secret: SECRET, database: db, clock, codeTtlMs: 60_000 });
  const app = miu({ plugins: [testAuth(), realtime, mm, party], logLevel: "silent" });
  const req = (user: string, path: string, method = "POST", body: unknown = {}) => app.request(path, as(user, method === "GET" ? {} : { method, body: JSON.stringify(body) }));
  return { clock, app, realtime, mm, party, req };
}

describe("game does not leak", () => {
  test("matchmaker join → match → status → expiry cycles drain queues, statuses and rooms", async () => {
    const { clock, realtime, mm, req } = gameApp();
    const r = await leakCheck("matchmaker cycles", async (i) => {
      const a = `u${i % 40}`;
      const b = `v${i % 40}`;
      await req(a, "/match/ranked/join");
      await req(b, "/match/ranked/join");
      await req(`w${i % 40}`, "/match/ranked/join");
      await req(`w${i % 40}`, "/match/ranked/leave", "DELETE");
      await settle(2);
      await req(a, "/match/ranked/status", "GET");
      clock.advance(6_000); // statuses expire, the created room is disposed
    }, { warmup: 500, perRound: 1000, rounds: 5 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect((mm.inspect().queues as any).ranked.waiting).toBe(0);
    expect(realtime.registry.list()).toEqual([]);
    expect(clock.pending).toBe(0);
  }, 120_000);

  test("QueueCore: join/leave/time-out/match cycles keep waiting and statuses bounded", async () => {
    const q = new QueueCore("ranked", { room: "arena", teamSize: 1, rating: "elo", widenAfterMs: 1_000, maxWaitMs: 5_000, statusTtlMs: 2_000 });
    let now = 0;
    const r = await leakCheck("queue core", (i) => {
      q.join({ userId: `a${i}`, name: "A", rating: 1000 }, now);
      q.join({ userId: `b${i}`, name: "B", rating: 5000 + i }, now); // never matches: times out
      if (i % 2) q.leave(`b${i}`);
      q.join({ userId: `c${i}`, name: "C", rating: 1000 }, now);
      q.run(now);
      now += 100;
    }, { perRound: 3000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    q.run(now + 10_000);
    expect(q.size).toBe(0);
    expect(Object.keys(q.snapshot().statuses)).toEqual([]);
  }, 60_000);

  test("lobbies created and abandoned are forgotten", async () => {
    const { party, req } = gameApp();
    const r = await leakCheck("lobbies abandoned", async (i) => {
      const user = `h${i % 40}`;
      const { lobby } = await (await req(user, "/lobbies")).json();
      await req(`g${i % 40}`, "/lobbies/join", "POST", { code: lobby.code });
      await req(`g${i % 40}`, `/lobbies/${lobby.id}/leave`);
      await req(user, `/lobbies/${lobby.id}/leave`);
    }, { warmup: 500, perRound: 2000, rounds: 5 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect((party.inspect() as { open: number }).open).toBe(0);
  }, 120_000);

  test("leaderboard submits (trusted and with single-use client proofs)", async () => {
    const clock = new FakeClock(Date.parse("2026-10-15T12:00:00Z"));
    const lb = leaderboard({ id: "pts", sort: "desc", resets: "daily", database: sqlite(":memory:"), clock, maxScore: 1e9, clientSubmit: { secret: SECRET, proofTtlMs: 1_000 }, rateLimit: { perMinute: 1e6, burst: 1e6 } });
    const app = miu({ plugins: [testAuth(), lb], logLevel: "silent" });
    const r = await leakCheck("leaderboard", async (i) => {
      await lb.submit(`p${i % 100}`, i);
      const proof = await signScoreProof(SECRET, { board: "pts", playerId: `c${i % 100}`, score: i, nonce: `n${i}` }, clock.now(), 1_000);
      await app.request("/leaderboards/pts/scores", as(`c${i % 100}`, { method: "POST", body: JSON.stringify({ score: i, proof }) }));
      clock.advance(50);
    }, { warmup: 500, perRound: 1000, rounds: 5 });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("creating and stopping matchmakers and lobbies does not pile up result sinks", async () => {
    const arena = gameRoom("sinkroom", { state: t.object({ ok: t.boolean() }), init: () => ({ ok: true }) }, { secret: SECRET });
    const realtime = rooms({ rooms: [arena] });
    const db = sqlite(":memory:");
    const r = await leakCheck("result sinks", () => {
      const mm = matchmaker({ rooms: realtime, secret: SECRET, database: db, queues: { q: { room: "sinkroom", teamSize: 1, rating: "elo", widenAfterMs: 1_000, maxWaitMs: 1_000 } } });
      const lb = lobbies({ rooms: realtime, room: "sinkroom", secret: SECRET, database: db });
      mm.stop();
      lb.stop();
    }, { perRound: 1000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);

  test("joins refused by the room's own onJoinRequest leave no pending seats behind", async () => {
    const picky = gameRoom("picky", {
      state: t.object({ ok: t.boolean() }),
      init: () => ({ ok: true }),
      onJoinRequest: () => {
        throw new Error("no");
      },
    }, { secret: SECRET });
    const clock = new FakeClock(0);
    const match = { id: "m1", queue: "q", rated: false, players: [{ userId: "u", name: "U", team: 0 }], teams: [["u"]] };
    const inst = new RoomInstance(picky, { id: "r1", clock, data: { match }, hooks: { onError: () => {} } });
    const ticket = await issueTicket(SECRET, { userId: "u", name: "U", roomType: "picky", roomId: "r1", matchId: "m1", team: 0 }, 0, 1e12);
    const sock = { id: "s", data: undefined, send() {}, close() {} } as any;
    const r = await leakCheck("refused joins", () => {
      inst.connect(sock, { name: "U", params: { ticket } });
      inst.disconnect(sock);
    }, { perRound: 3000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect((inst.snapshot().secret as any).__game.pending ?? []).toEqual([]);
  }, 60_000);

  test("fixedStep loops stop when their room closes", () => {
    const loop = fixedStep.define("step", { hz: 20, update: ({ room }) => void room.state.n++ });
    const type = defineRoom("loopy", {
      state: t.object({ n: t.number() }),
      init: () => ({ n: 0 }),
      timers: { ...loop.timers },
      onJoin: ({ room }) => {
        loop.start(room);
        fixedStep(room, 30, ({ room }) => void room.state.n++);
      },
    });
    const clock = new FakeClock(0);
    for (let i = 0; i < 50; i++) {
      const inst = new RoomInstance(type, { id: `r${i}`, clock });
      inst.connect({ id: `s${i}`, data: undefined, send() {}, close() {} } as any, { name: "Ann" });
      clock.advance(200);
      expect(inst.describe().state.n).toBeGreaterThan(0);
      inst.close();
      expect(clock.pending).toBe(0);
    }
  });
});

const APP = `
  import { miu, definePlugin } from "miujs";
  import { rooms, t } from "@miujs/realtime";
  import { gameRoom, lobbies, matchmaker, leaderboard } from "../src/index.ts";
  const SECRET = "${SECRET}";
  const auth = definePlugin({ name: "a", onRequest(ctx) { const h = ctx.headers.get("x-u"); if (h) ctx.user = { id: h, name: h, roles: [] }; } });
  const arena = gameRoom("arena", { state: t.object({ ok: t.boolean() }), init: () => ({ ok: true }) }, { secret: SECRET });
  const realtime = rooms({ rooms: [arena] });
  const mm = matchmaker({ rooms: realtime, secret: SECRET, queues: { ranked: { room: "arena", teamSize: 1, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 120_000 } } });
  const party = lobbies({ rooms: realtime, room: "arena", secret: SECRET });
  const wins = leaderboard({ id: "wins", sort: "desc", resets: "weekly" });
  const app = miu({ logLevel: "silent", plugins: [auth, realtime, mm, party, wins] });
  const post = (u, path) => app.request(path, { method: "POST", headers: { "x-u": u, "content-type": "application/json" }, body: "{}" });
`;

describe("game lets the process exit", () => {
  test("rooms + matchmaker + lobbies + leaderboard after ready(), a queued player, a match and a lobby", async () => {
    const r = await exitCheck(`${APP}
      await app.ready();
      await post("solo", "/match/ranked/join");             // waits: the widening timer is pending
      await post("a", "/match/ranked/join");
      await post("b", "/match/ranked/join");                // a match: a room and 5-minute statuses
      await new Promise((res) => setTimeout(res, 50));
      await post("h", "/lobbies");
      await wins.submit("a", 1);
    `, 3000, PKG);
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 10_000);

  test("listen(), match over HTTP, then stop() and the plugins' stop()", async () => {
    const r = await exitCheck(`${APP}
      const s = await app.listen(0, "127.0.0.1");
      const p = (u, path) => fetch(s.url + path.slice(1), { method: "POST", headers: { "x-u": u, "content-type": "application/json" }, body: "{}" });
      await p("solo", "/match/ranked/join");
      await p("a", "/match/ranked/join");
      await p("b", "/match/ranked/join");
      await new Promise((res) => setTimeout(res, 50));
      await s.stop();
      mm.stop(); party.stop(); realtime.stop();
    `, 3000, PKG);
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 10_000);
});

describe("QueueCore.run picks (speed rewrite)", () => {
  // The pre-optimization matcher, kept as the reference: filter + sort the whole queue per anchor.
  function reference(waiting: { userId: string; rating: number; region?: string; joinedAt: number; seq: number }[], need: number, win: (w: { joinedAt: number }) => number) {
    const order = [...waiting].sort((a, b) => a.joinedAt - b.joinedAt || a.seq - b.seq);
    const used = new Set<object>();
    const groups: string[][] = [];
    for (const anchor of order) {
      if (used.has(anchor)) continue;
      const w = win(anchor);
      const picks = order
        .filter((x) => x !== anchor && !used.has(x) && x.region === anchor.region && Math.abs(x.rating - anchor.rating) <= w)
        .sort((a, b) => Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating) || a.joinedAt - b.joinedAt || a.seq - b.seq)
        .slice(0, need - 1);
      if (picks.length < need - 1) continue;
      for (const x of [anchor, ...picks]) used.add(x);
      groups.push([anchor, ...picks].map((x) => x.userId));
    }
    return groups;
  }

  test("matches the reference matcher on random queues (ties, regions, team sizes)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 300; round++) {
      const teamSize = 1 + Math.floor(rnd() * 3);
      const regions = rnd() < 0.5 ? ["eu", "us"] : undefined;
      const cfg = { room: "a", teamSize, rating: "elo" as const, widenAfterMs: 1_000, maxWaitMs: 1e9, initialWindow: 20, widenBy: 30 };
      const q = new QueueCore("r", { ...cfg, region: regions }, { matchId: () => "m" });
      const n = Math.floor(rnd() * 40);
      const now = 5_000;
      const joined: { userId: string; rating: number; region?: string; joinedAt: number; seq: number }[] = [];
      for (let i = 0; i < n; i++) {
        const e = { userId: `u${i}`, name: "x", rating: 1000 + Math.floor(rnd() * 12) * 10, region: regions ? regions[Math.floor(rnd() * 2)] : undefined };
        const at = Math.floor(rnd() * 5) * 1_000;
        q.join(e, at);
        joined.push({ userId: e.userId, rating: e.rating, region: e.region, joinedAt: at, seq: i + 1 });
      }
      const want = reference(joined, q.matchSize, (w) => q.window(w, now));
      const got = q.run(now).matches.map((m) => m.players.map((p) => p.userId));
      expect(got).toEqual(want);
    }
  });
});
