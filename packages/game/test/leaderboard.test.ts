import { expect, test } from "bun:test";
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { FakeClock } from "@miujs/realtime";
import { leaderboard, periodKey, signScoreProof, type LeaderboardOptions } from "../src/leaderboard.ts";
import { GameStore } from "../src/store.ts";
import { as, testAuth } from "./helpers.ts";

const T = (iso: string) => Date.parse(iso);

test("period keys: daily, ISO weekly (2026-W42), monthly, never", () => {
  const now = T("2026-10-15T12:00:00Z");
  expect(periodKey("daily", now)).toBe("2026-10-15");
  expect(periodKey("weekly", now)).toBe("2026-W42");
  expect(periodKey("monthly", now)).toBe("2026-10");
  expect(periodKey("never", now)).toBe("all");
  expect(periodKey("weekly", T("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  expect(periodKey("weekly", T("2021-01-03T23:00:00Z"))).toBe("2020-W53");
  expect(periodKey("weekly", T("2024-12-30T00:00:00Z"))).toBe("2025-W01");
});

test("period keys follow the board's time zone (UTC by default)", () => {
  const early = T("2026-10-15T03:00:00Z"); // still Oct 14 in Los Angeles
  expect(periodKey("daily", early, "America/Los_Angeles")).toBe("2026-10-14");
  const mondayUtc = T("2026-10-19T02:00:00Z"); // Sunday evening in Los Angeles
  expect(periodKey("weekly", mondayUtc)).toBe("2026-W43");
  expect(periodKey("weekly", mondayUtc, "America/Los_Angeles")).toBe("2026-W42");
  expect(periodKey("monthly", T("2026-10-31T23:30:00Z"), "Asia/Tokyo")).toBe("2026-11");
  expect(() => periodKey("daily", early, "Mars/Olympus")).toThrow(/time zone/);
});

function board(opts: Partial<LeaderboardOptions> = {}) {
  const clock = new FakeClock(T("2026-10-15T12:00:00Z"));
  const lb = leaderboard({ id: "wins", sort: "desc", resets: "weekly", database: sqlite(":memory:"), clock, maxScore: 1_000_000, ...opts });
  return { clock, lb };
}

test("best mode keeps each player's best score; top() ranks with ties sharing a rank", async () => {
  const { lb } = board();
  await lb.submit("a", 50);
  await lb.submit("b", 80);
  await lb.submit("a", 40); // not better
  await lb.submit("c", 80);
  await lb.submit("d", 10);
  expect(await lb.top(3)).toEqual([
    { rank: 1, playerId: "b", score: 80, name: null },
    { rank: 1, playerId: "c", score: 80, name: null },
    { rank: 3, playerId: "a", score: 50, name: null },
  ]);
  expect(await lb.rank("a")).toEqual({ rank: 3, score: 50, period: "2026-W42" });
  expect(await lb.rank("zz")).toBeNull();
});

test("sum mode adds scores; asc boards rank low scores first", async () => {
  const { lb } = board({ mode: "sum" });
  await lb.submit("a", 3);
  await lb.submit("a", 4);
  expect(await lb.rank("a")).toMatchObject({ score: 7 });
  const asc = board({ id: "speedrun", sort: "asc", mode: "best" }).lb;
  await asc.submit("a", 95.5);
  await asc.submit("a", 90.1);
  await asc.submit("b", 92);
  expect((await asc.top(10)).map((e) => [e.playerId, e.score])).toEqual([["a", 90.1], ["b", 92]]);
  expect(await asc.rank("b")).toMatchObject({ rank: 2 });
});

test("around() returns n neighbours above and below the player", async () => {
  const { lb } = board();
  for (const [p, s] of [["a", 10], ["b", 20], ["c", 30], ["d", 40], ["e", 50], ["f", 60]] as const) await lb.submit(p, s);
  expect((await lb.around("c", 1)).map((e) => [e.rank, e.playerId])).toEqual([[3, "d"], [4, "c"], [5, "b"]]);
  expect((await lb.around("f", 2)).map((e) => e.playerId)).toEqual(["f", "e", "d"]);
  expect(await lb.around("nobody", 2)).toEqual([]);
});

test("weekly boards reset when the period changes; older periods stay queryable", async () => {
  const { lb, clock } = board();
  await lb.submit("a", 50);
  clock.advance(7 * 86_400_000);
  expect(await lb.top(10)).toEqual([]);
  await lb.submit("b", 5);
  expect((await lb.top(10, { period: "2026-W42" })).map((e) => e.playerId)).toEqual(["a"]);
  expect((await lb.top(10)).map((e) => e.playerId)).toEqual(["b"]);
});

test("sanity bounds: non-finite, above maxScore or below minScore is rejected", async () => {
  const { lb } = board({ maxScore: 100, minScore: 0 });
  for (const bad of [101, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect((await lb.submit("a", bad).catch((e) => e)).code).toBe("MIU_E_GAME_SCORE_INVALID");
  }
  expect(await lb.rank("a")).toBeNull();
});

test("client submissions are rate limited per player", async () => {
  const { lb, clock } = board({ rateLimit: { perMinute: 6, burst: 2 } });
  await lb.submit("a", 1, { source: "client" });
  await lb.submit("a", 2, { source: "client" });
  expect((await lb.submit("a", 3, { source: "client" }).catch((e) => e)).code).toBe("MIU_E_GAME_SCORE_RATE_LIMITED");
  await lb.submit("b", 1, { source: "client" }); // other players unaffected
  await lb.submit("a", 9); // trusted (room) submissions are not rate limited
  clock.advance(10_000);
  await lb.submit("a", 4, { source: "client" });
});

test("routes: top/around/rank are MCP tools; client scores are disabled by default", async () => {
  const { lb } = board();
  const app = miu({ plugins: [testAuth(), lb], mcp: true, logLevel: "silent" });
  await lb.submit("a", 5);
  await lb.submit("b", 7);
  const top = await app.request("/leaderboards/wins/top?n=1");
  expect(await top.json()).toEqual({ board: "wins", period: "2026-W42", entries: [{ rank: 1, playerId: "b", score: 7, name: null }] });
  expect(await (await app.request("/leaderboards/wins/rank/a")).json()).toEqual({ board: "wins", period: "2026-W42", rank: 2, score: 5 });
  expect((await (await app.request("/leaderboards/wins/around/a?n=1")).json()).entries.map((e: any) => e.playerId)).toEqual(["b", "a"]);
  const names = app.tools().map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["leaderboard_wins_top", "leaderboard_wins_around", "leaderboard_wins_rank"]));
  expect(names).not.toContain("leaderboard_wins_submit");
  const res = await app.request("/leaderboards/wins/scores", as("a", { method: "POST", body: JSON.stringify({ score: 1_000 }) }));
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe("MIU_E_GAME_CLIENT_SCORES_DISABLED");
});

test("with clientSubmit a signed proof is required, bound to the player, board and score, and used once", async () => {
  const secret = "proof-secret-0123456789abcdef";
  const { lb, clock } = board({ clientSubmit: { secret } });
  const app = miu({ plugins: [testAuth(), lb], logLevel: "silent" });
  const post = (user: string, body: unknown) => app.request("/leaderboards/wins/scores", as(user, { method: "POST", body: JSON.stringify(body) }));
  expect((await post("a", { score: 10 })).status).toBe(401);
  const proof = await signScoreProof(secret, { board: "wins", playerId: "a", score: 10, nonce: "n1" }, clock.now());
  expect((await post("a", { score: 11, proof })).status).toBe(401); // score differs
  expect((await post("b", { score: 10, proof })).status).toBe(401); // another player's proof
  const ok = await post("a", { score: 10, proof });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ score: 10, rank: 1 });
  const replay = await post("a", { score: 10, proof });
  expect(replay.status).toBe(401);
  expect((await replay.json()).error.code).toBe("MIU_E_GAME_PROOF_INVALID");
  const anon = await app.request("/leaderboards/wins/scores", { method: "POST", body: JSON.stringify({ score: 10, proof }), headers: { "content-type": "application/json" } });
  expect(anon.status).toBe(401);
});

test("names come from the players table when the board shares the game database", async () => {
  const db = sqlite(":memory:");
  const store = new GameStore(db);
  await store.ensurePlayer("a", "Ann");
  const lb = leaderboard({ id: "pts", sort: "desc", resets: "never", database: db, maxScore: 10 });
  await lb.submit("a", 3);
  expect(await lb.top(1)).toEqual([{ rank: 1, playerId: "a", score: 3, name: "Ann" }]);
  expect(lb.inspect()).toMatchObject({ id: "pts", sort: "desc", resets: "never", mode: "best", timezone: "UTC", maxScore: 10, clientSubmit: false });
});

test("bad options fail fast", () => {
  expect(() => leaderboard({ id: "bad id", sort: "desc", resets: "never" })).toThrow(/id/);
  expect(() => leaderboard({ id: "x", sort: "up" as any, resets: "never" })).toThrow(/sort/);
  expect(() => leaderboard({ id: "x", sort: "desc", resets: "hourly" as any })).toThrow(/resets/);
  expect(() => leaderboard({ id: "x", sort: "desc", resets: "daily", timezone: "Nowhere/Land" })).toThrow(/time zone/);
});
