import { expect, test } from "bun:test";
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { FakeClock } from "@miujs/realtime";
import { defineAchievements } from "../src/achievements.ts";
import { profiles } from "../src/profiles.ts";
import { GameStore } from "../src/store.ts";
import { as, testAuth } from "./helpers.ts";

function setup() {
  const db = sqlite(":memory:");
  const clock = new FakeClock(5);
  const achievements = defineAchievements({ firstWin: { title: "First win", check: (s) => s.wins >= 1 }, secretOne: { title: "Secret", hidden: true, check: (s) => (s.x ?? 0) > 0 } });
  const plugin = profiles({ database: db, achievements, clock });
  const app = miu({ plugins: [testAuth(), plugin], mcp: true, logLevel: "silent" });
  return { app, store: new GameStore(db, { clock, achievements }), plugin };
}

test("GET /players/me creates your profile from the signed-in user", async () => {
  const { app } = setup();
  expect((await app.request("/players/me")).status).toBe(401);
  const r = await app.request("/players/me", as("u1:Ann"));
  expect(await r.json()).toMatchObject({ profile: { id: "u1", displayName: "Ann", gamesPlayed: 0, ratings: {} }, achievements: [] });
});

test("PATCH /players/me updates display name and avatar file key, validated", async () => {
  const { app } = setup();
  await app.request("/players/me", as("u1:Ann"));
  const ok = await app.request("/players/me", as("u1", { method: "PATCH", body: JSON.stringify({ displayName: "Annie", avatarKey: "avatars/u1.png" }) }));
  expect((await ok.json()).profile).toMatchObject({ displayName: "Annie", avatarKey: "avatars/u1.png" });
  const bad = await app.request("/players/me", as("u1", { method: "PATCH", body: JSON.stringify({ displayName: "" }) }));
  expect(bad.status).toBe(400);
  const traversal = await app.request("/players/me", as("u1", { method: "PATCH", body: JSON.stringify({ avatarKey: "../../etc/passwd" }) }));
  expect(traversal.status).toBe(400);
});

test("GET /players/:id is public (an MCP tool) and lists unlocked achievements, hiding hidden locked ones", async () => {
  const { app, store } = setup();
  await store.ensurePlayer("u2", "Bob");
  await store.addStats("u2", { wins: 1 });
  const r = await app.request("/players/u2");
  expect(await r.json()).toEqual({
    profile: { id: "u2", displayName: "Bob", avatarKey: null, gamesPlayed: 0, gamesWon: 0, ratings: {}, createdAt: 5 },
    achievements: [{ id: "firstWin", title: "First win", at: 5 }],
  });
  expect((await app.request("/players/nobody")).status).toBe(404);
  expect(app.tools().map((t) => t.name)).toContain("player_profile");
});

test("inspect lists the achievements", () => {
  const { plugin } = setup();
  expect(plugin.inspect()).toMatchObject({ path: "/players", achievements: ["firstWin", "secretOne"] });
});
