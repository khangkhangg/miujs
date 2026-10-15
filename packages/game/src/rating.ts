// Rating math: Elo and a "lite" Glicko-2 (fixed volatility, no iterative volatility solve).
// Pure functions; the store (ratings.ts) persists the numbers.

/** How a match ended. `teams` lists player ids per team (1v1: [["a"], ["b"]]); default: everyone in `ranking` plays alone. */
export interface Outcome {
  teams?: string[][];
  /** Winning players (any member wins for the whole team). Empty or missing with no ranking: a draw. */
  winners?: string[];
  /** Finishing order, best first; each entry is the players sharing that place. */
  ranking?: string[][];
}

export interface Glicko {
  rating: number;
  /** Rating deviation (uncertainty). */
  rd: number;
  /** Volatility. Kept fixed by the lite variant. */
  vol: number;
}

export const DEFAULT_RATING: Readonly<Glicko> = Object.freeze({ rating: 1500, rd: 350, vol: 0.06 });
export const DEFAULT_K = 32;

/** Expected score of `a` against `b` (0..1). */
export function eloExpected(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/** One rating period: `rating + K * Σ(score - expected)`. */
export function eloUpdate(rating: number, games: { opponent: number; score: number }[], k = DEFAULT_K): number {
  let sum = 0;
  for (const g of games) sum += g.score - eloExpected(rating, g.opponent);
  return rating + k * sum;
}

/** The teams of an outcome: `teams`, or one team per player of `ranking`. */
export function outcomeTeams(outcome: Outcome): string[][] {
  return outcome.teams ?? (outcome.ranking ?? []).flat().map((p) => [p]);
}

/** Place (0 = best) of every team. Draw when nothing decides. */
export function teamPlaces(outcome: Outcome): number[] {
  const { winners, ranking } = outcome;
  const teams = outcomeTeams(outcome);
  if (ranking && ranking.length) {
    const place = new Map<string, number>();
    ranking.forEach((group, i) => group.forEach((p) => place.set(p, i)));
    return teams.map((team) => Math.min(...team.map((p) => place.get(p) ?? ranking.length)));
  }
  const won = new Set(winners ?? []);
  if (won.size === 0) return teams.map(() => 0);
  return teams.map((team) => (team.some((p) => won.has(p)) ? 0 : 1));
}

function pairScore(a: number, b: number): number {
  return a < b ? 1 : a === b ? 0.5 : 0;
}

/**
 * New Elo ratings for every player in a match. Teams play as their average rating; every
 * member gets the team's delta. With more than two teams each pair counts, scaled by K/(n-1).
 */
export function eloMatch(ratings: Record<string, number>, outcome: Outcome, k = DEFAULT_K): Record<string, number> {
  const teams = outcomeTeams(outcome);
  const places = teamPlaces(outcome);
  const avg = teams.map((team) => team.reduce((s, p) => s + (ratings[p] ?? DEFAULT_RATING.rating), 0) / team.length);
  const out: Record<string, number> = {};
  const scale = teams.length > 1 ? k / (teams.length - 1) : 0;
  teams.forEach((team, i) => {
    let sum = 0;
    for (let j = 0; j < teams.length; j++) if (j !== i) sum += pairScore(places[i], places[j]) - eloExpected(avg[i], avg[j]);
    for (const p of team) out[p] = (ratings[p] ?? DEFAULT_RATING.rating) + scale * sum;
  });
  return out;
}

const SCALE = 173.7178;

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Glicko-2 update for one rating period with volatility held fixed. */
export function glicko2Update(player: Glicko, games: { rating: number; rd: number; score: number }[]): Glicko {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const phiStar = Math.sqrt(phi * phi + player.vol * player.vol);
  if (!games.length) return { rating: player.rating, rd: phiStar * SCALE, vol: player.vol };
  let vInv = 0;
  let delta = 0;
  for (const o of games) {
    const muJ = (o.rating - 1500) / SCALE;
    const gj = g(o.rd / SCALE);
    const e = 1 / (1 + Math.exp(-gj * (mu - muJ)));
    vInv += gj * gj * e * (1 - e);
    delta += gj * (o.score - e);
  }
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + vInv);
  const muNew = mu + phiNew * phiNew * delta;
  return { rating: muNew * SCALE + 1500, rd: phiNew * SCALE, vol: player.vol };
}

/** Glicko-2 lite for a match: each team plays every other team as one opponent (mean rating, RMS deviation). */
export function glicko2Match(ratings: Record<string, Glicko>, outcome: Outcome): Record<string, Glicko> {
  const teams = outcomeTeams(outcome);
  const places = teamPlaces(outcome);
  const get = (p: string) => ratings[p] ?? DEFAULT_RATING;
  const composite = teams.map((team) => ({
    rating: team.reduce((s, p) => s + get(p).rating, 0) / team.length,
    rd: Math.sqrt(team.reduce((s, p) => s + get(p).rd ** 2, 0) / team.length),
  }));
  const out: Record<string, Glicko> = {};
  teams.forEach((team, i) => {
    const games = composite.flatMap((c, j) => (j === i ? [] : [{ ...c, score: pairScore(places[i], places[j]) }]));
    for (const p of team) out[p] = glicko2Update(get(p), games);
  });
  return out;
}
