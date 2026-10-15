import { expect, test } from "bun:test";
import { QueueCore, type QueueConfig } from "../src/queue.ts";

const base: QueueConfig = { room: "arena", teamSize: 1, teams: 2, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 60_000 };
let n = 0;
const ids = () => `m${++n}`;

function core(cfg: Partial<QueueConfig> = {}) {
  n = 0;
  return new QueueCore("ranked", { ...base, ...cfg }, { matchId: ids });
}

test("two players inside each other's window are matched on the next run", () => {
  const q = core();
  q.join({ userId: "a", name: "Ann", rating: 1500 }, 0);
  expect(q.status("a", 0)).toMatchObject({ state: "queued", since: 0, window: 100 });
  expect(q.run(0).matches).toEqual([]);
  q.join({ userId: "b", name: "Bob", rating: 1550 }, 10);
  const { matches } = q.run(10);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ id: "m1", queue: "ranked", room: "arena", createdAt: 10, teams: [["b"], ["a"]] });
  expect(matches[0].players.map((p) => [p.userId, p.team])).toEqual([["a", 1], ["b", 0]]);
  expect(q.status("a", 10)).toMatchObject({ state: "matching", matchId: "m1" });
  expect(q.size).toBe(0);
});

test("the rating window widens every widenAfterMs; nextDue points at the next widening", () => {
  const q = core();
  q.join({ userId: "a", name: "Ann", rating: 1500 }, 0);
  q.join({ userId: "b", name: "Bob", rating: 1800 }, 0);
  expect(q.run(0).matches).toEqual([]);
  expect(q.nextDue(0)).toBe(5_000);
  expect(q.run(5_000).matches).toEqual([]); // window 200 < 300
  expect(q.nextDue(5_000)).toBe(10_000);
  expect(q.status("a", 9_999)).toMatchObject({ window: 200 });
  const { matches } = q.run(10_000); // window 300
  expect(matches.map((m) => m.players.map((p) => p.userId).sort())).toEqual([["a", "b"]]);
});

test("the oldest player anchors the match and takes the closest ratings", () => {
  const q = core();
  q.join({ userId: "old", name: "Old", rating: 1500 }, 0);
  q.join({ userId: "far", name: "Far", rating: 1590 }, 1);
  q.join({ userId: "near", name: "Near", rating: 1510 }, 2);
  const { matches } = q.run(2);
  expect(matches[0].players.map((p) => p.userId).sort()).toEqual(["near", "old"]);
  expect(q.status("far", 2).state).toBe("queued");
});

test("players who wait past maxWaitMs time out", () => {
  const q = core();
  q.join({ userId: "a", name: "Ann", rating: 1500 }, 0);
  q.run(59_999);
  expect(q.status("a", 59_999).state).toBe("queued");
  expect(q.nextDue(59_999)).toBe(60_000);
  const r = q.run(60_000);
  expect(r.timedOut).toEqual(["a"]);
  expect(q.status("a", 60_000)).toMatchObject({ state: "timeout" });
  expect(q.size).toBe(0);
});

test("teams of two are balanced by snake draft", () => {
  const q = core({ teamSize: 2, widenAfterMs: 1_000 });
  for (const [u, r] of [["a", 1560], ["b", 1540], ["c", 1520], ["d", 1500]] as const) q.join({ userId: u, name: u, rating: r }, 0);
  const { matches } = q.run(0);
  expect(matches[0].teams).toEqual([["a", "d"], ["b", "c"]]);
});

test("regions never mix, and an unknown region is rejected", () => {
  const q = core({ region: ["eu", "us"] });
  q.join({ userId: "a", name: "a", rating: 1500, region: "eu" }, 0);
  q.join({ userId: "b", name: "b", rating: 1500, region: "us" }, 0);
  expect(q.run(0).matches).toEqual([]);
  q.join({ userId: "c", name: "c", rating: 1500, region: "us" }, 0);
  expect(q.run(0).matches[0].players.map((p) => p.userId).sort()).toEqual(["b", "c"]);
  expect(() => q.join({ userId: "d", name: "d", rating: 1500, region: "mars" }, 0)).toThrow(/region/);
  expect(() => q.join({ userId: "e", name: "e", rating: 1500 }, 0)).toThrow(/region/);
});

test("joining twice is an error; leaving removes the player", () => {
  const q = core();
  q.join({ userId: "a", name: "a", rating: 1500 }, 0);
  let code = "";
  try {
    q.join({ userId: "a", name: "a", rating: 1500 }, 1);
  } catch (e: any) {
    code = e.code;
  }
  expect(code).toBe("MIU_E_GAME_ALREADY_QUEUED");
  expect(q.leave("a")).toBe(true);
  expect(q.leave("a")).toBe(false);
  expect(q.status("a", 2)).toEqual({ state: "idle" });
});

test("assign() turns a matching player into matched; statuses expire after statusTtlMs", () => {
  const q = core({ statusTtlMs: 1_000 });
  q.join({ userId: "a", name: "a", rating: 1500 }, 0);
  q.join({ userId: "b", name: "b", rating: 1500 }, 0);
  const [m] = q.run(0).matches;
  const room = { type: "arena", id: "r1", url: "/rooms/arena/r1" };
  q.assign(m.id, { a: { room, ticket: "T-a", team: 1 }, b: { room, ticket: "T-b", team: 0 } }, 5);
  expect(q.status("a", 5)).toEqual({ state: "matched", matchId: "m1", room: { type: "arena", id: "r1", url: "/rooms/arena/r1" }, ticket: "T-a", team: 1, at: 5 });
  expect(q.nextDue(5)).toBe(1_005);
  q.run(1_005);
  expect(q.status("a", 1_005)).toEqual({ state: "idle" });
  // A matched player may queue again.
  q.join({ userId: "b", name: "b", rating: 1500 }, 1_006);
  expect(q.status("b", 1_006).state).toBe("queued");
});

test("same inputs give the same matches (deterministic), and snapshots restore the queue", () => {
  const play = () => {
    const q = core({ teamSize: 2 });
    const ratings = [1500, 1720, 1480, 1610, 1390, 1555, 1660, 1430];
    ratings.forEach((r, i) => q.join({ userId: `u${i}`, name: `u${i}`, rating: r }, i * 700));
    const out = [];
    for (let t = 0; t <= 30_000; t += 2_500) out.push(...q.run(t).matches.map((m) => m.teams));
    return out;
  };
  expect(play()).toEqual(play());
  const q = core();
  q.join({ userId: "a", name: "a", rating: 1500 }, 0);
  const copy = QueueCore.restore("ranked", { ...base }, q.snapshot(), { matchId: ids });
  copy.join({ userId: "b", name: "b", rating: 1500 }, 1);
  expect(copy.run(1).matches).toHaveLength(1);
});

test("bad queue config fails fast with MIU_E_GAME_QUEUE_CONFIG", () => {
  expect(() => new QueueCore("x", { ...base, teamSize: 0 })).toThrow(/teamSize/);
  expect(() => new QueueCore("x", { ...base, teams: 1 })).toThrow(/teams/);
  expect(() => new QueueCore("x", { ...base, rating: "trueskill" as any })).toThrow(/rating/);
});
