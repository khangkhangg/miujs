// Shared game data for the arena: one database for profiles, ratings, matches and leaderboards
// (in-memory SQLite locally, D1 binding "DB" on Workers), the leaderboard and achievements.

import { defineAchievements, defaultDatabase, leaderboard } from "../../src/index.ts";

export const database = defaultDatabase();

export const achievements = defineAchievements({
  firstWin: { title: "First win", description: "Win a ranked duel", check: (s) => s.wins >= 1 },
  regular: { title: "Regular", description: "Play 10 duels", check: (s) => s.games >= 10 },
});

/** Wins this week (Monday 00:00 UTC reset). Only the room submits, one point per win. */
export const wins = leaderboard({ id: "arena-wins", sort: "desc", resets: "weekly", mode: "sum", maxScore: 1, minScore: 1, database });
