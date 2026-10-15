import { expect, test } from "bun:test";
import { sqlite } from "@miujs/db";
import { FakeClock } from "@miujs/realtime";
import { defineAchievements, type Unlock } from "../src/achievements.ts";
import { GameStore } from "../src/store.ts";

const ach = () =>
  defineAchievements({
    firstWin: { title: "First win", check: (s) => s.wins >= 1 },
    sharpshooter: { title: "Sharpshooter", check: (s) => (s.hits ?? 0) >= 10 },
    broken: { title: "Broken", check: () => { throw new Error("boom"); } },
  });

test("evaluate() lists passing checks; a throwing check never passes", () => {
  const a = ach();
  expect(a.evaluate({ games: 1, wins: 1, losses: 0, draws: 0 })).toEqual(["firstWin"]);
  expect(a.evaluate({ games: 0, wins: 0, losses: 0, draws: 0, hits: 12 })).toEqual(["sharpshooter"]);
});

test("unlocks are stored once and emit achievement.unlocked once", async () => {
  const achievements = ach();
  const events: Unlock[] = [];
  achievements.on("achievement.unlocked", (u) => events.push(u));
  const s = new GameStore(sqlite(":memory:"), { clock: new FakeClock(7), achievements });
  await s.ensurePlayer("a", "Ann");
  const first = await s.addStats("a", { hits: 10 });
  expect(first.unlocked).toEqual([{ playerId: "a", id: "sharpshooter", title: "Sharpshooter", at: 7 }]);
  const again = await s.addStats("a", { hits: 5 });
  expect(again.unlocked).toEqual([]);
  expect(events.map((e) => e.id)).toEqual(["sharpshooter"]);
  expect(await s.unlocked("a")).toEqual([{ id: "sharpshooter", at: 7 }]);
});

test("winning a reported match unlocks firstWin for the winner only", async () => {
  const achievements = ach();
  const events: Unlock[] = [];
  achievements.on("achievement.unlocked", (u) => events.push(u));
  const s = new GameStore(sqlite(":memory:"), { clock: new FakeClock(0), achievements });
  await s.createMatch({ id: "m1", queue: "q", room: "arena", createdAt: 0, players: [{ userId: "a", name: "A", rating: 1500, team: 0 }, { userId: "b", name: "B", rating: 1500, team: 1 }], teams: [["a"], ["b"]] }, "elo");
  const r = await s.reportResult("m1", { winners: ["b"] });
  expect(r.unlocked.map((u) => [u.playerId, u.id])).toEqual([["b", "firstWin"]]);
  expect(events).toHaveLength(1);
});

test("invalid achievement definitions fail fast", () => {
  expect(() => defineAchievements({ "bad id!": { title: "x", check: () => true } })).toThrow(/MIU_E_GAME_ACHIEVEMENT_INVALID|invalid/);
  expect(() => defineAchievements({ ok: { title: "x" } as any })).toThrow(/invalid/);
});
