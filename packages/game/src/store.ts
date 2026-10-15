// Player profiles, per-queue ratings, matches, stats and achievement unlocks in SQL (bun:sqlite
// locally, D1 on Workers, through @miujs/db's D1-compatible interface).
//
// Results are applied in one batch (a transaction) whose statements are all guarded by "this
// match is still pending" and whose last statement marks it finished, so concurrent or repeated
// reports of the same match apply exactly once.

import { migrateOnce, resolveDatabase, type Database, type DatabaseSource, type Migration, type Statement } from "@miujs/db";
import type { Env } from "miujs";
import { systemClock, type Clock } from "@miujs/realtime";
import type { AchievementSet, PlayerStats, Unlock } from "./achievements.ts";
import { gameErrors } from "./errors.ts";
import type { MatchSpec } from "./queue.ts";
import { DEFAULT_K, DEFAULT_RATING, eloMatch, glicko2Match, outcomeTeams, teamPlaces, type Glicko, type Outcome } from "./rating.ts";

export const gameMigrations: Migration[] = [
  {
    id: "game_001_players",
    sql: `
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_key TEXT,
  games_played INTEGER NOT NULL DEFAULT 0,
  games_won INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS player_ratings (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  queue TEXT NOT NULL,
  rating REAL NOT NULL,
  rd REAL NOT NULL,
  vol REAL NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, queue)
);
CREATE INDEX IF NOT EXISTS player_ratings_by_queue ON player_ratings (queue, rating);
`,
  },
  {
    id: "game_002_matches",
    sql: `
CREATE TABLE IF NOT EXISTS game_matches (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  room_type TEXT NOT NULL,
  room_id TEXT,
  rating TEXT NOT NULL,
  players TEXT NOT NULL,
  teams TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS player_stats (
  player_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (player_id, key)
);
CREATE TABLE IF NOT EXISTS player_achievements (
  player_id TEXT NOT NULL,
  achievement TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, achievement)
);
`,
  },
  {
    id: "game_003_leaderboards",
    sql: `
CREATE TABLE IF NOT EXISTS leaderboard_scores (
  board TEXT NOT NULL,
  period TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score REAL NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board, period, player_id)
);
CREATE INDEX IF NOT EXISTS leaderboard_scores_rank ON leaderboard_scores (board, period, score);
`,
  },
  {
    // Used score-proof nonces, shared by every isolate (an in-memory set let a proof be replayed
    // on another Workers isolate).
    id: "game_004_score_nonces",
    sql: `
CREATE TABLE IF NOT EXISTS leaderboard_nonces (
  board TEXT NOT NULL,
  player_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (board, player_id, nonce)
);
CREATE INDEX IF NOT EXISTS leaderboard_nonces_expiry ON leaderboard_nonces (expires_at);
`,
  },
];

export interface RatingRow extends Glicko {
  games: number;
  wins: number;
}

export interface Profile {
  id: string;
  displayName: string;
  avatarKey: string | null;
  gamesPlayed: number;
  gamesWon: number;
  ratings: Record<string, RatingRow>;
  createdAt: number;
}

export type RatingMode = "elo" | "glicko2-lite" | "none";

export interface MatchRecord {
  id: string;
  queue: string;
  roomType: string;
  roomId: string | null;
  rating: RatingMode;
  players: { userId: string; name: string; team: number }[];
  teams: string[][];
  status: "pending" | "finished";
  result: Result | null;
  createdAt: number;
  finishedAt: number | null;
}

/** What a room reports: winning players, or the finishing order. */
export type Result = { winners: string[] } | { ranking: string[][] };

export interface ResultSummary {
  matchId: string;
  /** True when this match already had a result; nothing changed. */
  duplicate: boolean;
  ratings: Record<string, { before: number; after: number }>;
  unlocked: Unlock[];
}

export interface GameStoreOptions {
  clock?: Clock;
  /** Elo K factor. Default 32. */
  k?: number;
  achievements?: AchievementSet;
}

const GUARD = "(SELECT status FROM game_matches WHERE id = ?) = 'pending'";

interface PlayerRow {
  id: string;
  display_name: string;
  avatar_key: string | null;
  games_played: number;
  games_won: number;
  created_at: number;
}

export class GameStore {
  readonly db: Database;
  readonly achievements: AchievementSet | undefined;
  private clock: Clock;
  private k: number;

  constructor(database: Database, opts: GameStoreOptions = {}) {
    this.db = database;
    this.clock = opts.clock ?? systemClock;
    this.k = opts.k ?? DEFAULT_K;
    this.achievements = opts.achievements;
  }

  /** Apply the game tables (once per database per isolate). */
  ready(): Promise<string[]> {
    return migrateOnce(this.db, gameMigrations);
  }

  // ---- players ------------------------------------------------------------------------------

  async ensurePlayer(id: string, name: string): Promise<Profile> {
    await this.ready();
    const now = this.clock.now();
    await this.db.prepare("INSERT OR IGNORE INTO players (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(id, name.slice(0, 64), now, now).run();
    return (await this.profile(id))!;
  }

  async profile(id: string): Promise<Profile | null> {
    await this.ready();
    const row = await this.db.prepare("SELECT * FROM players WHERE id = ?").bind(id).first<PlayerRow>();
    if (!row) return null;
    const { results } = await this.db.prepare("SELECT queue, rating, rd, vol, games, wins FROM player_ratings WHERE player_id = ? ORDER BY queue").bind(id).all<RatingRow & { queue: string }>();
    const ratings: Record<string, RatingRow> = {};
    for (const r of results) ratings[r.queue] = { rating: r.rating, rd: r.rd, vol: r.vol, games: r.games, wins: r.wins };
    return { id: row.id, displayName: row.display_name, avatarKey: row.avatar_key, gamesPlayed: row.games_played, gamesWon: row.games_won, ratings, createdAt: row.created_at };
  }

  async updateProfile(id: string, patch: { displayName?: string; avatarKey?: string | null }): Promise<Profile> {
    await this.ready();
    const cur = await this.profile(id);
    if (!cur) throw gameErrors.playerNotFound(id);
    const name = patch.displayName !== undefined ? patch.displayName.slice(0, 64) : cur.displayName;
    const avatar = patch.avatarKey !== undefined ? patch.avatarKey : cur.avatarKey;
    await this.db.prepare("UPDATE players SET display_name = ?, avatar_key = ?, updated_at = ? WHERE id = ?").bind(name, avatar, this.clock.now(), id).run();
    return (await this.profile(id))!;
  }

  // ---- ratings ------------------------------------------------------------------------------

  async rating(playerId: string, queue: string): Promise<RatingRow> {
    await this.ready();
    const r = await this.db.prepare("SELECT rating, rd, vol, games, wins FROM player_ratings WHERE player_id = ? AND queue = ?").bind(playerId, queue).first<RatingRow>();
    return r ?? { ...DEFAULT_RATING, games: 0, wins: 0 };
  }

  /** Set a rating directly (seeding, admin tools, tests). */
  async setRating(playerId: string, queue: string, rating: number, rd = DEFAULT_RATING.rd): Promise<void> {
    await this.ensurePlayer(playerId, playerId);
    await this.db
      .prepare("INSERT INTO player_ratings (player_id, queue, rating, rd, vol, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, queue) DO UPDATE SET rating = excluded.rating, rd = excluded.rd, updated_at = excluded.updated_at")
      .bind(playerId, queue, rating, rd, DEFAULT_RATING.vol, this.clock.now())
      .run();
  }

  // ---- matches ------------------------------------------------------------------------------

  /** Record a match before its room starts, so only its players can be reported later. */
  async createMatch(spec: MatchSpec, rating: RatingMode, roomId: string | null = null): Promise<void> {
    await this.ready();
    const now = this.clock.now();
    const stmts: Statement[] = spec.players.map((p) => this.db.prepare("INSERT OR IGNORE INTO players (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(p.userId, p.name.slice(0, 64), now, now));
    stmts.push(
      this.db
        .prepare("INSERT OR IGNORE INTO game_matches (id, queue, room_type, room_id, rating, players, teams, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .bind(spec.id, spec.queue, spec.room, roomId, rating, JSON.stringify(spec.players.map(({ userId, name, team }) => ({ userId, name, team }))), JSON.stringify(spec.teams), spec.createdAt),
    );
    await this.db.batch(stmts);
  }

  async match(id: string): Promise<MatchRecord | null> {
    await this.ready();
    const r = await this.db.prepare("SELECT * FROM game_matches WHERE id = ?").bind(id).first<Record<string, any>>();
    if (!r) return null;
    return {
      id: r.id,
      queue: r.queue,
      roomType: r.room_type,
      roomId: r.room_id,
      rating: r.rating,
      players: JSON.parse(r.players),
      teams: JSON.parse(r.teams),
      status: r.status,
      result: r.result ? JSON.parse(r.result) : null,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  }

  /**
   * Apply a match result: ratings (per the match's queue and system), games/wins/losses/draws
   * stats, then achievements. Call it only from the authoritative room (server side). Repeated
   * reports of the same match are no-ops (`duplicate: true`).
   */
  async reportResult(matchId: string, result: Result): Promise<ResultSummary> {
    const m = await this.match(matchId);
    if (!m) throw gameErrors.matchUnknown(matchId);
    const outcome = checkResult(m, result);
    if (m.status !== "pending") return { matchId, duplicate: true, ratings: {}, unlocked: [] };
    const now = this.clock.now();
    const ids = m.players.map((p) => p.userId);
    const teams = outcomeTeams(outcome);
    const places = teamPlaces(outcome);
    const allTied = places.every((p) => p === places[0]);
    const verdict = new Map<string, "wins" | "losses" | "draws">();
    teams.forEach((team, i) => team.forEach((p) => verdict.set(p, allTied ? "draws" : places[i] === 0 ? "wins" : "losses")));

    const stmts: Statement[] = [];
    const ratings: ResultSummary["ratings"] = {};
    if (m.rating !== "none") {
      const before: Record<string, RatingRow> = {};
      for (const id of ids) before[id] = await this.rating(id, m.queue);
      const after: Record<string, Glicko> =
        m.rating === "elo"
          ? Object.fromEntries(Object.entries(eloMatch(Object.fromEntries(ids.map((id) => [id, before[id].rating])), outcome, this.k)).map(([id, r]) => [id, { ...before[id], rating: r }]))
          : glicko2Match(before, outcome);
      for (const id of ids) {
        ratings[id] = { before: before[id].rating, after: after[id].rating };
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO player_ratings (player_id, queue, rating, rd, vol, games, wins, updated_at) SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE ${GUARD}
               ON CONFLICT(player_id, queue) DO UPDATE SET rating = excluded.rating, rd = excluded.rd, vol = excluded.vol, games = games + 1, wins = wins + excluded.wins, updated_at = excluded.updated_at`,
            )
            .bind(id, m.queue, after[id].rating, after[id].rd, after[id].vol, verdict.get(id) === "wins" ? 1 : 0, now, matchId),
        );
      }
    }
    for (const id of ids) {
      const v = verdict.get(id) ?? "losses";
      stmts.push(this.db.prepare(`UPDATE players SET games_played = games_played + 1, games_won = games_won + ?, updated_at = ? WHERE id = ? AND ${GUARD}`).bind(v === "wins" ? 1 : 0, now, id, matchId));
      for (const [key, val] of [["games", 1], [v, 1]] as const) stmts.push(this.statStmt(id, key, val, matchId));
    }
    stmts.push(this.db.prepare("UPDATE game_matches SET status = 'finished', result = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(JSON.stringify(result), now, matchId));
    const out = await this.db.batch(stmts);
    if (out[out.length - 1].meta.changes !== 1) return { matchId, duplicate: true, ratings: {}, unlocked: [] };
    const unlocked: Unlock[] = [];
    for (const id of ids) unlocked.push(...(await this.unlock(id)));
    return { matchId, duplicate: false, ratings, unlocked };
  }

  // ---- stats & achievements ------------------------------------------------------------------

  async stats(playerId: string): Promise<PlayerStats> {
    await this.ready();
    const { results } = await this.db.prepare("SELECT key, value FROM player_stats WHERE player_id = ?").bind(playerId).all<{ key: string; value: number }>();
    const s: PlayerStats = { games: 0, wins: 0, losses: 0, draws: 0 };
    for (const r of results) s[r.key] = r.value;
    return s;
  }

  /** Add to custom counters (e.g. `{ kills: 3 }`), then evaluate achievements. */
  async addStats(playerId: string, delta: Record<string, number>): Promise<{ stats: PlayerStats; unlocked: Unlock[] }> {
    await this.ready();
    const stmts = Object.entries(delta)
      .filter(([, v]) => Number.isFinite(v))
      .map(([k, v]) => this.statStmt(playerId, k, v, null));
    if (stmts.length) await this.db.batch(stmts);
    const unlocked = await this.unlock(playerId);
    return { stats: await this.stats(playerId), unlocked };
  }

  /** Achievement ids a player has, with unlock times. */
  async unlocked(playerId: string): Promise<{ id: string; at: number }[]> {
    await this.ready();
    const { results } = await this.db.prepare("SELECT achievement, unlocked_at FROM player_achievements WHERE player_id = ? ORDER BY unlocked_at, achievement").bind(playerId).all<{ achievement: string; unlocked_at: number }>();
    return results.map((r) => ({ id: r.achievement, at: r.unlocked_at }));
  }

  private statStmt(playerId: string, key: string, value: number, guardMatch: string | null): Statement {
    const sql = `INSERT INTO player_stats (player_id, key, value) SELECT ?, ?, ? WHERE ${guardMatch ? GUARD : "1"} ON CONFLICT(player_id, key) DO UPDATE SET value = value + excluded.value`;
    return guardMatch ? this.db.prepare(sql).bind(playerId, key, value, guardMatch) : this.db.prepare(sql).bind(playerId, key, value);
  }

  /** Store every newly passing achievement once; emit `achievement.unlocked` for each new one. */
  private async unlock(playerId: string): Promise<Unlock[]> {
    const set = this.achievements;
    if (!set) return [];
    const passing = set.evaluate(await this.stats(playerId));
    const out: Unlock[] = [];
    for (const id of passing) {
      const at = this.clock.now();
      const r = await this.db.prepare("INSERT OR IGNORE INTO player_achievements (player_id, achievement, unlocked_at) VALUES (?, ?, ?)").bind(playerId, id, at).run();
      if (r.meta.changes === 1) {
        const u: Unlock = { playerId, id, title: set.defs[id].title, at };
        out.push(u);
        set.emit(u);
      }
    }
    return out;
  }
}

/** Validate a reported result against the match roster; returns it as a rating outcome. */
function checkResult(m: MatchRecord, result: Result): Outcome {
  const roster = new Set(m.players.map((p) => p.userId));
  const r = result as { winners?: unknown; ranking?: unknown };
  const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (r && isIds(r.winners)) {
    const bad = r.winners.find((w) => !roster.has(w));
    if (bad !== undefined) throw gameErrors.resultInvalid(`"${bad}" did not play in this match`);
    return { teams: m.teams, winners: r.winners };
  }
  if (r && Array.isArray(r.ranking) && r.ranking.every(isIds)) {
    const seen = new Set<string>();
    for (const id of (r.ranking as string[][]).flat()) {
      if (!roster.has(id)) throw gameErrors.resultInvalid(`"${id}" did not play in this match`);
      if (seen.has(id)) throw gameErrors.resultInvalid(`"${id}" appears twice in the ranking`);
      seen.add(id);
    }
    return { teams: m.teams, ranking: r.ranking as string[][] };
  }
  throw gameErrors.resultInvalid("expected { winners: string[] } or { ranking: string[][] }");
}

const stores = new WeakMap<Database, GameStore>();

/** A store per database: pass a Database, or a `d1("DB")` ref resolved against `env` on Workers. */
export function storeFor(source: DatabaseSource, env: Env, opts: GameStoreOptions = {}): GameStore {
  const db = resolveDatabase(source, env);
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new GameStore(db, opts)));
  return s;
}
