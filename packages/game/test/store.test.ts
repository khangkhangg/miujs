import { expect, test } from "bun:test";
import { sqlite } from "@miujs/db";
import { FakeClock } from "@miujs/realtime";
import { GameStore, gameMigrations } from "../src/store.ts";
import type { MatchSpec } from "../src/queue.ts";

function store(opts: { k?: number } = {}) {
  const clock = new FakeClock(1_000);
  return { clock, s: new GameStore(sqlite(":memory:"), { clock, ...opts }) };
}

const duel = (id = "m1"): MatchSpec => ({
  id,
  queue: "ranked",
  room: "arena",
  createdAt: 1_000,
  players: [
    { userId: "a", name: "Ann", rating: 1500, team: 0 },
    { userId: "b", name: "Bob", rating: 1500, team: 1 },
  ],
  teams: [["a"], ["b"]],
});

test("migrations create the players table and friends; ensurePlayer is idempotent", async () => {
  const { s } = store();
  expect(gameMigrations.map((m) => m.id)[0]).toBe("game_001_players");
  const p = await s.ensurePlayer("a", "Ann");
  expect(p).toEqual({ id: "a", displayName: "Ann", avatarKey: null, gamesPlayed: 0, gamesWon: 0, ratings: {}, createdAt: 1_000 });
  await s.ensurePlayer("a", "Someone else");
  expect((await s.profile("a"))!.displayName).toBe("Ann");
  expect(await s.profile("nobody")).toBeNull();
});

test("updateProfile changes the display name and avatar file key", async () => {
  const { s } = store();
  await s.ensurePlayer("a", "Ann");
  const p = await s.updateProfile("a", { displayName: "Annie", avatarKey: "avatars/a.png" });
  expect(p).toMatchObject({ displayName: "Annie", avatarKey: "avatars/a.png" });
  const missing = await s.updateProfile("zz", { displayName: "x" }).catch((e) => e);
  expect(missing.code).toBe("MIU_E_GAME_PLAYER_NOT_FOUND");
});

test("ratings default to 1500 per queue", async () => {
  const { s } = store();
  expect(await s.rating("a", "ranked")).toEqual({ rating: 1500, rd: 350, vol: 0.06, games: 0, wins: 0 });
});

test("reportResult applies Elo (±16 for an even duel), counts games and wins, and records the match", async () => {
  const { s, clock } = store();
  await s.createMatch(duel(), "elo");
  clock.advance(5_000);
  const r = await s.reportResult("m1", { winners: ["a"] });
  expect(r.duplicate).toBe(false);
  expect(r.ratings.a.before).toBe(1500);
  expect(r.ratings.a.after).toBeCloseTo(1516, 6);
  expect(r.ratings.b.after).toBeCloseTo(1484, 6);
  expect((await s.rating("a", "ranked")).rating).toBeCloseTo(1516, 6);
  const a = await s.profile("a");
  expect(a).toMatchObject({ gamesPlayed: 1, gamesWon: 1 });
  expect(a!.ratings.ranked.rating).toBeCloseTo(1516, 6);
  expect((await s.profile("b"))).toMatchObject({ gamesPlayed: 1, gamesWon: 0 });
  expect(await s.stats("a")).toMatchObject({ games: 1, wins: 1, losses: 0, draws: 0 });
  expect(await s.stats("b")).toMatchObject({ games: 1, wins: 0, losses: 1 });
  expect(await s.match("m1")).toMatchObject({ id: "m1", status: "finished", finishedAt: 6_000, result: { winners: ["a"] } });
});

test("reporting the same match twice changes nothing the second time", async () => {
  const { s } = store();
  await s.createMatch(duel(), "elo");
  await s.reportResult("m1", { winners: ["a"] });
  const again = await s.reportResult("m1", { winners: ["b"] });
  expect(again.duplicate).toBe(true);
  expect((await s.rating("a", "ranked")).rating).toBeCloseTo(1516, 6);
  expect(await s.stats("a")).toMatchObject({ games: 1, wins: 1 });
});

test("concurrent reports of one match apply once", async () => {
  const { s } = store();
  await s.createMatch(duel(), "elo");
  const rs = await Promise.all([s.reportResult("m1", { winners: ["a"] }), s.reportResult("m1", { winners: ["a"] })]);
  expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
  expect(await s.rating("a", "ranked")).toMatchObject({ games: 1, wins: 1 });
  expect((await s.rating("a", "ranked")).rating).toBeCloseTo(1516, 6);
  expect(await s.stats("a")).toMatchObject({ games: 1, wins: 1 });
});

test("results must name only players of the match, and the match must exist", async () => {
  const { s } = store();
  await s.createMatch(duel(), "elo");
  expect((await s.reportResult("m1", { winners: ["mallory"] }).catch((e) => e)).code).toBe("MIU_E_GAME_RESULT_INVALID");
  expect((await s.reportResult("m1", { ranking: [["a"], ["a"]] }).catch((e) => e)).code).toBe("MIU_E_GAME_RESULT_INVALID");
  expect((await s.reportResult("m1", {} as any).catch((e) => e)).code).toBe("MIU_E_GAME_RESULT_INVALID");
  expect((await s.reportResult("nope", { winners: ["a"] }).catch((e) => e)).code).toBe("MIU_E_GAME_MATCH_UNKNOWN");
});

test("a draw is { winners: [] } and counts as a draw for both", async () => {
  const { s } = store();
  await s.createMatch({ ...duel(), players: [{ userId: "a", name: "A", rating: 1600, team: 0 }, { userId: "b", name: "B", rating: 1400, team: 1 }] }, "elo");
  await s.setRating("a", "ranked", 1600);
  await s.setRating("b", "ranked", 1400);
  await s.reportResult("m1", { winners: [] });
  expect((await s.rating("a", "ranked")).rating).toBeCloseTo(1600 + 32 * (0.5 - 0.7597469), 4);
  expect(await s.stats("a")).toMatchObject({ games: 1, draws: 1, wins: 0 });
});

test("glicko2-lite queues store rating and deviation", async () => {
  const { s } = store();
  await s.createMatch(duel(), "glicko2-lite");
  await s.reportResult("m1", { winners: ["b"] });
  const b = await s.rating("b", "ranked");
  expect(b.rating).toBeGreaterThan(1500);
  expect(b.rd).toBeLessThan(350);
});

test("unrated matches (lobbies) update stats but not ratings", async () => {
  const { s } = store();
  await s.createMatch({ ...duel(), queue: "lobby" }, "none");
  await s.reportResult("m1", { ranking: [["b"], ["a"]] });
  expect(await s.stats("b")).toMatchObject({ wins: 1 });
  expect((await s.profile("b"))!.ratings).toEqual({});
});

test("addStats increments custom counters", async () => {
  const { s } = store();
  await s.ensurePlayer("a", "Ann");
  await s.addStats("a", { kills: 3 });
  const r = await s.addStats("a", { kills: 2, deaths: 1 });
  expect(r.stats).toMatchObject({ kills: 5, deaths: 1, games: 0, wins: 0 });
});

test("K factor is configurable", async () => {
  const { s } = store({ k: 16 });
  await s.createMatch(duel(), "elo");
  await s.reportResult("m1", { winners: ["a"] });
  expect((await s.rating("a", "ranked")).rating).toBeCloseTo(1508, 6);
});
