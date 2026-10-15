import { expect, test } from "bun:test";
import { eloExpected, eloUpdate, eloMatch, glicko2Update, glicko2Match, DEFAULT_RATING } from "../src/rating.ts";

test("Elo expected score is the logistic curve with a 400-point scale", () => {
  expect(eloExpected(1500, 1500)).toBe(0.5);
  expect(eloExpected(1600, 1400)).toBeCloseTo(0.7597, 4);
  expect(eloExpected(1400, 1600)).toBeCloseTo(0.2403, 4);
});

test("Elo update over a rating period matches the textbook example (1613 → 1601, K=32)", () => {
  // Wikipedia "Elo rating system": 1613 plays 1609 (L), 1477 (D), 1388 (W), 1586 (W), 1720 (L): 2.5 points, expected 2.867.
  const r = eloUpdate(1613, [
    { opponent: 1609, score: 0 },
    { opponent: 1477, score: 0.5 },
    { opponent: 1388, score: 1 },
    { opponent: 1586, score: 1 },
    { opponent: 1720, score: 0 },
  ], 32);
  expect(Math.round(r)).toBe(1601);
});

test("eloMatch with winners: equal 1v1 moves ±16 at K=32 and is zero-sum", () => {
  const out = eloMatch({ a: 1500, b: 1500 }, { teams: [["a"], ["b"]], winners: ["a"] }, 32);
  expect(out.a).toBeCloseTo(1516, 6);
  expect(out.b).toBeCloseTo(1484, 6);
});

test("eloMatch draws (no winners) pull ratings together", () => {
  const out = eloMatch({ a: 1600, b: 1400 }, { teams: [["a"], ["b"]], winners: [] }, 32);
  expect(out.a).toBeCloseTo(1600 + 32 * (0.5 - 0.7597469), 4);
  expect(out.b).toBeCloseTo(1400 + 32 * (0.5 - 0.2402531), 4);
});

test("eloMatch teams use the team average and every member gets the team delta", () => {
  const out = eloMatch({ a: 1700, b: 1500, c: 1600, d: 1600 }, { teams: [["a", "b"], ["c", "d"]], winners: ["c", "d"] }, 32);
  expect(out.a - 1700).toBeCloseTo(-16, 6);
  expect(out.b - 1500).toBeCloseTo(-16, 6);
  expect(out.c - 1600).toBeCloseTo(16, 6);
});

test("eloMatch ranking (free-for-all) compares every pair, scaled by K/(n-1)", () => {
  const out = eloMatch({ a: 1500, b: 1500, c: 1500 }, { ranking: [["a"], ["b"], ["c"]] }, 32);
  expect(out.a).toBeCloseTo(1516, 6);
  expect(out.b).toBeCloseTo(1500, 6);
  expect(out.c).toBeCloseTo(1484, 6);
});

test("Glicko-2 lite reproduces Glickman's worked example (r 1464.06, RD 151.52)", () => {
  const r = glicko2Update({ rating: 1500, rd: 200, vol: 0.06 }, [
    { rating: 1400, rd: 30, score: 1 },
    { rating: 1550, rd: 100, score: 0 },
    { rating: 1700, rd: 300, score: 0 },
  ]);
  expect(r.rating).toBeCloseTo(1464.06, 1);
  expect(r.rd).toBeCloseTo(151.52, 1);
  expect(r.vol).toBe(0.06);
});

test("Glicko-2 lite: a player who did not play only gains uncertainty", () => {
  const r = glicko2Update({ rating: 1500, rd: 200, vol: 0.06 }, []);
  expect(r.rating).toBe(1500);
  expect(r.rd).toBeCloseTo(200.27, 1);
});

test("glicko2Match 1v1: winner goes up, loser down, RD shrinks", () => {
  const out = glicko2Match({ a: { ...DEFAULT_RATING }, b: { ...DEFAULT_RATING } }, { teams: [["a"], ["b"]], winners: ["a"] });
  expect(out.a.rating).toBeGreaterThan(1500);
  expect(out.b.rating).toBeLessThan(1500);
  expect(out.a.rd).toBeLessThan(350);
  expect(out.a.rating - 1500).toBeCloseTo(1500 - out.b.rating, 6);
});
