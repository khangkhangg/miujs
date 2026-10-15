// Leaderboards: one SQL table (`leaderboard_scores`, indexed by board, period and score) shared
// by every board. Scores live in periods (`2026-10-15`, `2026-W42`, `2026-10`, `all`), computed in
// the board's time zone, so "weekly" boards reset at local Monday 00:00.
//
//   export const wins = leaderboard({ id: "wins", sort: "desc", resets: "weekly", mode: "sum", maxScore: 1 });
//   await wins.submit(userId, 1);            // trusted: from the room / server code
//   await wins.top(10); await wins.around(userId, 3); await wins.rank(userId);
//   miu({ plugins: [wins] })                 // GET /leaderboards/wins/top|around/:playerId|rank/:playerId (MCP tools)
//
// Trust: `submit()` is server-side and trusted (sanity bounds still apply). Clients can only
// post scores when `clientSubmit: { secret }` is set, and then only with a proof signed by a
// server you trust (`signScoreProof`), single-use, bound to board, player and score.

import { definePlugin, route, t, type CloudflareNeeds, type Env } from "miujs";
import { migrateOnce, resolveDatabase, type Database, type DatabaseSource } from "@miujs/db";
import { KeyedLimiter, systemClock, type Clock } from "@miujs/realtime";
import { defaultDatabase, isD1Ref } from "./db.ts";
import { gameErrors } from "./errors.ts";
import { leaderboardManage } from "./manage.ts";
import { signToken, verifyToken } from "./sign.ts";
import { gameMigrations } from "./store.ts";

export type Resets = "daily" | "weekly" | "monthly" | "never";

export interface LeaderboardOptions {
  /** Board id (letters, digits, `_`, `-`): used in routes and MCP tool names. */
  id: string;
  /** `desc`: high scores first (points). `asc`: low first (times). */
  sort: "desc" | "asc";
  resets: Resets;
  /** `best` keeps each player's best score per period; `sum` adds them up. Default `best`. */
  mode?: "best" | "sum";
  /** IANA time zone for period boundaries. Default `UTC`. */
  timezone?: string;
  /** Reject scores above this (sanity bound). Strongly recommended. */
  maxScore?: number;
  /** Reject scores below this. Default: no bound. */
  minScore?: number;
  /** Per-player limit on client submissions. Default 10/minute, burst 5. */
  rateLimit?: { perMinute?: number; burst?: number };
  /** Accept scores from clients with a signed proof. Default off (rooms submit server-side). */
  clientSubmit?: false | { secret: string; proofTtlMs?: number };
  /** Default: D1 "DB" on Workers, the shared in-memory SQLite database elsewhere. */
  database?: DatabaseSource;
  /** Route prefix. Default `/leaderboards`. */
  path?: string;
  clock?: Clock;
}

export interface Entry {
  rank: number;
  playerId: string;
  score: number;
  /** Display name from the players table (null when the player has no profile). */
  name: string | null;
}

export interface SubmitResult {
  board: string;
  period: string;
  playerId: string;
  /** The stored score after this submission (best or sum). */
  score: number;
  improved: boolean;
  rank: number;
}

// ---- periods --------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function ymd(at: number, timeZone: string): [number, number, number] {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      throw gameErrors.timezoneInvalid(timeZone);
    }
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return [get("year"), get("month"), get("day")];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The period a moment falls in: `2026-10-15` (daily), `2026-W42` (ISO week), `2026-10` (monthly), `all`. */
export function periodKey(resets: Resets, at: number, timeZone = "UTC"): string {
  if (resets === "never") {
    ymd(at, timeZone); // still validate the zone
    return "all";
  }
  const [y, m, d] = ymd(at, timeZone);
  if (resets === "daily") return `${y}-${pad(m)}-${pad(d)}`;
  if (resets === "monthly") return `${y}-${pad(m)}`;
  // ISO 8601 week: the week with the year's first Thursday is week 1; weeks start on Monday.
  const day = Date.UTC(y, m - 1, d);
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = day + (3 - dow) * 86_400_000;
  const isoYear = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / (7 * 86_400_000));
  return `${isoYear}-W${pad(week)}`;
}

// ---- score proofs -----------------------------------------------------------------------------

/** Sign a score on a trusted server so a client may relay it (`clientSubmit: { secret }`). */
export function signScoreProof(secret: string, p: { board: string; playerId: string; score: number; nonce: string }, now: number, ttlMs = 300_000): Promise<string> {
  return signToken(secret, "score", { b: p.board, p: p.playerId, s: p.score, n: p.nonce, exp: now + ttlMs });
}

// ---- the board --------------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function check(opts: LeaderboardOptions): void {
  const fail = (m: string, fix: string) => {
    throw gameErrors.leaderboardConfig(`leaderboard("${opts.id}"): ${m}`, fix);
  };
  if (!ID_RE.test(opts.id ?? "")) fail("id must be 1-40 letters, digits, '_' or '-'", 'e.g. leaderboard({ id: "weekly-wins", ... }).');
  if (opts.sort !== "desc" && opts.sort !== "asc") fail(`sort must be "desc" or "asc"`, 'Use sort: "desc" for points, "asc" for times.');
  if (!["daily", "weekly", "monthly", "never"].includes(opts.resets)) fail(`resets must be daily, weekly, monthly or never`, 'e.g. resets: "weekly".');
  if (opts.mode !== undefined && opts.mode !== "best" && opts.mode !== "sum") fail(`mode must be "best" or "sum"`, 'e.g. mode: "sum" to add up wins.');
  if (opts.clientSubmit && (typeof opts.clientSubmit.secret !== "string" || opts.clientSubmit.secret.length < 16)) fail("clientSubmit.secret must be 16+ characters", "Pass clientSubmit: { secret: env.SCORE_SECRET } (32+ random characters).");
  periodKey(opts.resets, 0, opts.timezone ?? "UTC");
}

/** A leaderboard and its plugin (routes + MCP tools). */
export function leaderboard(opts: LeaderboardOptions) {
  check(opts);
  const id = opts.id;
  const mode = opts.mode ?? "best";
  const tz = opts.timezone ?? "UTC";
  const desc = opts.sort === "desc";
  const clock = opts.clock ?? systemClock;
  const source = opts.database ?? defaultDatabase();
  const prefix = `${(opts.path ?? "/leaderboards").replace(/\/+$/, "")}/${id}`;
  const perMinute = opts.rateLimit?.perMinute ?? 10;
  const limiter = new KeyedLimiter({ perSecond: perMinute / 60, burst: opts.rateLimit?.burst ?? 5 });
  const usedNonces = new Map<string, number>();
  let lastEnv: Env = {};

  const better = desc ? ">" : "<";
  const worse = desc ? "<" : ">";
  const dir = desc ? "DESC" : "ASC";
  const rdir = desc ? "ASC" : "DESC";

  async function dbFor(env?: Env): Promise<Database> {
    const db = resolveDatabase(source, env ?? lastEnv);
    await migrateOnce(db, gameMigrations);
    return db;
  }

  const current = () => periodKey(opts.resets, clock.now(), tz);

  async function rankOf(db: Database, period: string, score: number): Promise<number> {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM leaderboard_scores WHERE board = ? AND period = ? AND score ${better} ?`).bind(id, period, score).first<number>("n");
    return (n ?? 0) + 1;
  }

  const board = {
    id,
    /** The current period key (or the one `at` falls in). */
    periodKey: (at: number = clock.now()) => periodKey(opts.resets, at, tz),

    /**
     * Record a score. Server-side calls (`source: "room"`, the default) are trusted; pass
     * `source: "client"` for anything a client sent, which is rate limited per player.
     */
    async submit(playerId: string, score: number, o: { source?: "room" | "client"; env?: Env } = {}): Promise<SubmitResult> {
      if (typeof score !== "number" || !Number.isFinite(score)) throw gameErrors.scoreInvalid("not a finite number");
      if (opts.maxScore !== undefined && score > opts.maxScore) throw gameErrors.scoreInvalid(`above maxScore ${opts.maxScore}`);
      if (opts.minScore !== undefined && score < opts.minScore) throw gameErrors.scoreInvalid(`below minScore ${opts.minScore}`);
      if (o.source === "client" && !limiter.take(`${playerId}`, clock.now())) throw gameErrors.scoreRateLimited(perMinute);
      const db = await dbFor(o.env);
      const period = current();
      const now = clock.now();
      const prev = await db.prepare("SELECT score FROM leaderboard_scores WHERE board = ? AND period = ? AND player_id = ?").bind(id, period, playerId).first<number>("score");
      const merge = mode === "sum" ? "score + excluded.score" : `CASE WHEN excluded.score ${better} score THEN excluded.score ELSE score END`;
      const touch = mode === "sum" ? "excluded.updated_at" : `CASE WHEN excluded.score ${better} score THEN excluded.updated_at ELSE updated_at END`;
      await db
        .prepare(
          `INSERT INTO leaderboard_scores (board, period, player_id, score, submissions, updated_at) VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(board, period, player_id) DO UPDATE SET score = ${merge}, submissions = submissions + 1, updated_at = ${touch}`,
        )
        .bind(id, period, playerId, score, now)
        .run();
      const stored = (await db.prepare("SELECT score FROM leaderboard_scores WHERE board = ? AND period = ? AND player_id = ?").bind(id, period, playerId).first<number>("score"))!;
      return { board: id, period, playerId, score: stored, improved: prev === null || stored !== prev, rank: await rankOf(db, period, stored) };
    },

    async top(n = 10, o: { period?: string; env?: Env } = {}): Promise<Entry[]> {
      const db = await dbFor(o.env);
      const period = o.period ?? current();
      const { results } = await db
        .prepare(
          `SELECT l.player_id AS playerId, l.score AS score, p.display_name AS name FROM leaderboard_scores l LEFT JOIN players p ON p.id = l.player_id
           WHERE l.board = ? AND l.period = ? ORDER BY l.score ${dir}, l.updated_at ASC, l.player_id ASC LIMIT ?`,
        )
        .bind(id, period, Math.max(0, Math.min(1000, Math.floor(n))))
        .all<{ playerId: string; score: number; name: string | null }>();
      const out: Entry[] = [];
      results.forEach((r, i) => {
        const rank = i > 0 && r.score === results[i - 1].score ? out[i - 1].rank : i + 1;
        out.push({ rank, playerId: r.playerId, score: r.score, name: r.name ?? null });
      });
      return out;
    },

    async rank(playerId: string, o: { period?: string; env?: Env } = {}): Promise<{ rank: number; score: number; period: string } | null> {
      const db = await dbFor(o.env);
      const period = o.period ?? current();
      const score = await db.prepare("SELECT score FROM leaderboard_scores WHERE board = ? AND period = ? AND player_id = ?").bind(id, period, playerId).first<number>("score");
      if (score === null) return null;
      return { rank: await rankOf(db, period, score), score, period };
    },

    /** The player plus up to `n` entries above and `n` below, best first. */
    async around(playerId: string, n = 5, o: { period?: string; env?: Env } = {}): Promise<Entry[]> {
      const db = await dbFor(o.env);
      const period = o.period ?? current();
      const me = await db.prepare("SELECT score, updated_at FROM leaderboard_scores WHERE board = ? AND period = ? AND player_id = ?").bind(id, period, playerId).first<{ score: number; updated_at: number }>();
      if (!me) return [];
      const k = Math.max(0, Math.min(100, Math.floor(n)));
      const cols = "l.player_id AS playerId, l.score AS score, p.display_name AS name";
      const from = "FROM leaderboard_scores l LEFT JOIN players p ON p.id = l.player_id WHERE l.board = ? AND l.period = ?";
      const above = await db
        .prepare(
          `SELECT ${cols} ${from} AND (l.score ${better} ? OR (l.score = ? AND (l.updated_at < ? OR (l.updated_at = ? AND l.player_id < ?))))
           ORDER BY l.score ${rdir}, l.updated_at DESC, l.player_id DESC LIMIT ?`,
        )
        .bind(id, period, me.score, me.score, me.updated_at, me.updated_at, playerId, k)
        .all<{ playerId: string; score: number; name: string | null }>();
      const below = await db
        .prepare(
          `SELECT ${cols} ${from} AND (l.score ${worse} ? OR (l.score = ? AND (l.updated_at > ? OR (l.updated_at = ? AND l.player_id > ?))))
           ORDER BY l.score ${dir}, l.updated_at ASC, l.player_id ASC LIMIT ?`,
        )
        .bind(id, period, me.score, me.score, me.updated_at, me.updated_at, playerId, k)
        .all<{ playerId: string; score: number; name: string | null }>();
      const self = await db.prepare("SELECT display_name FROM players WHERE id = ?").bind(playerId).first<string>("display_name");
      const rows = [...above.results.reverse(), { playerId, score: me.score, name: self ?? null }, ...below.results];
      const out: Entry[] = [];
      for (const r of rows) out.push({ rank: await rankOf(db, period, r.score), playerId: r.playerId, score: r.score, name: r.name ?? null });
      return out;
    },
  };

  async function checkProof(proof: unknown, playerId: string, score: number): Promise<void> {
    const cs = opts.clientSubmit;
    if (!cs) throw gameErrors.clientScoresDisabled(id);
    const now = clock.now();
    let p: { b: string; p: string; s: number; n: string; exp: number };
    try {
      p = await verifyToken(cs.secret, "score", proof, now);
    } catch {
      throw gameErrors.proofInvalid();
    }
    if (p.b !== id || p.p !== playerId || p.s !== score || typeof p.n !== "string") throw gameErrors.proofInvalid();
    for (const [k, exp] of usedNonces) if (exp <= now) usedNonces.delete(k);
    const key = `${p.p}:${p.n}`;
    if (usedNonces.has(key)) throw gameErrors.proofInvalid();
    usedNonces.set(key, p.exp);
  }

  const q = t.object({ n: t.optional(t.integer({ min: 1, max: 100 })), period: t.optional(t.string({ maxLength: 16 })) });
  const qp = t.object({ period: t.optional(t.string({ maxLength: 16 })) });
  const routes = [
    route.get(`${prefix}/top`, {
      name: `leaderboard_${id}_top`,
      summary: `Top players on the "${id}" leaderboard (${opts.resets} periods; default the current one)`,
      tags: ["game"],
      query: q,
      handler: async ({ query, env }) => {
        const period = query.period ?? current();
        return { board: id, period, entries: await board.top(query.n ?? 10, { period, env }) };
      },
    }),
    route.get(`${prefix}/around/:playerId`, {
      name: `leaderboard_${id}_around`,
      summary: `A player's neighbours on the "${id}" leaderboard (n above and n below)`,
      tags: ["game"],
      params: t.object({ playerId: t.string({ maxLength: 128 }) }),
      query: q,
      handler: async ({ params, query, env }) => {
        const period = query.period ?? current();
        return { board: id, period, entries: await board.around(params.playerId, query.n ?? 5, { period, env }) };
      },
    }),
    route.get(`${prefix}/rank/:playerId`, {
      name: `leaderboard_${id}_rank`,
      summary: `A player's rank and score on the "${id}" leaderboard`,
      tags: ["game"],
      params: t.object({ playerId: t.string({ maxLength: 128 }) }),
      query: qp,
      handler: async ({ params, query, env }) => {
        const period = query.period ?? current();
        const r = await board.rank(params.playerId, { period, env });
        return { board: id, period, rank: r?.rank ?? null, score: r?.score ?? null };
      },
    }),
    route.post(`${prefix}/scores`, {
      name: `leaderboard_${id}_submit`,
      summary: `Submit a client score to "${id}" (needs a signed proof; off unless clientSubmit is set)`,
      tags: ["game"],
      auth: "required",
      mcp: false,
      body: t.object({ score: t.number(), proof: t.optional(t.string({ maxLength: 4096 })) }),
      handler: async ({ body, user, env }) => {
        await checkProof(body.proof, user.id, body.score);
        return board.submit(user.id, body.score, { source: "client", env });
      },
    }),
  ];

  const plugin = definePlugin({
    name: `leaderboard:${id}`,
    routes,
    onRequest(ctx) {
      lastEnv = ctx.env;
    },
    inspect: () => ({
      id,
      sort: opts.sort,
      resets: opts.resets,
      mode,
      timezone: tz,
      period: current(),
      maxScore: opts.maxScore ?? null,
      minScore: opts.minScore ?? null,
      clientSubmit: !!opts.clientSubmit,
      routes: routes.map((r) => `${r.method} ${r.path}`),
      warnings: opts.maxScore === undefined ? ["no maxScore: any finite score is accepted from rooms"] : [],
    }),
    cloudflare: (): CloudflareNeeds => (isD1Ref(source) ? { d1: [source.binding] } : {}),
    /** Operator view for @miujs/admin: entries in rank order, remove one, reset a period. */
    manage: () => leaderboardManage({ id, sort: opts.sort, resets: opts.resets, mode, db: dbFor, period: current }),
  });
  return Object.assign(plugin, board);
}

export type Leaderboard = ReturnType<typeof leaderboard>;

