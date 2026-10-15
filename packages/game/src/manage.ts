// Operator views of the game kit (rendered by @miujs/admin through `Plugin.manage()`).
//
// Matchmaker: queue lengths and wait times, matches per minute, long-polls and live game rooms;
// the waiting players (remove one); runtime matching knobs and `closeAfterResultMs`; closing
// finished rooms now. On Cloudflare each queue is one Durable Object, so queue numbers, the list
// and the knobs are read from / sent to those objects; game rooms cannot be enumerated there.
//
// Leaderboard: the current period, entry count and top score; entries in rank order (remove
// one); reset a period. Tickets, signing secrets and client-submit secrets are never shown.

import { errors, t, type Context, type Env, type ManageAction, type ManageSection, type ManageSettings, type ManageStat, type ManageValue, type Schema } from "miujs";
import type { Database } from "@miujs/db";
import type { Clock } from "@miujs/realtime";
import { durableAdmin, type MatchHost, type NamespaceLike } from "./cloudflare.ts";
import { gameErrors } from "./errors.ts";
import type { QueueConfig, QueueCore, QueueTuning, WaitingView } from "./queue.ts";
import { closeAfterResultOf, isReported, setCloseAfterResult } from "./room.ts";

const MAX_PAGE = 100;
/** Status stops counting game rooms after this many, so opening the page stays cheap. */
const SCAN_CAP = 10_000;

const pageSize = (n: number) => Math.max(1, Math.min(MAX_PAGE, Math.floor(n) || MAX_PAGE));

/** The parts of an in-process room the matchmaker view touches. */
interface LiveRoom {
  type: string;
  isClosed: boolean;
  room: any;
  close(reason?: string): void;
}

export interface MatchmakerManageDeps {
  queues: Record<string, QueueConfig>;
  clock: Clock;
  /** In-process queues (created on demand). */
  local(): { cores: Map<string, QueueCore>; refresh(queue: string): void };
  /** The queue Durable Object namespace for this request, or null off Workers. */
  namespace(ctx: Context): NamespaceLike | null;
  host(ctx: Context): MatchHost;
  /** Long-polls waiting on a status right now (local only). */
  longPolls(): number;
  /** In-process rooms of the rooms plugin, when it exposes them. */
  rooms(): Iterable<LiveRoom> | null;
}

interface Tuned {
  queues: Record<string, QueueTuning>;
  closeAfterResultMs: Record<string, number | false>;
}

export function matchmakerManage(d: MatchmakerManageDeps): ManageSection[] {
  const names = Object.keys(d.queues);
  const roomTypes = [...new Set(names.map((n) => d.queues[n].room))];
  const queueOf = (q: string) => {
    if (!Object.prototype.hasOwnProperty.call(d.queues, q)) throw gameErrors.queueUnknown(q, names);
    return q;
  };

  /** Stats + knobs per queue, from this process or from each queue's Durable Object. */
  async function inspect(ctx: Context, q: string) {
    const ns = d.namespace(ctx);
    if (ns) return durableAdmin(ns).inspect(q);
    const core = d.local().cores.get(q)!;
    return { stats: core.stats(d.clock.now()), tuning: core.tuning() };
  }

  async function entries(ctx: Context, q: string, offset: number, limit: number, search?: string): Promise<{ rows: WaitingView[]; more: boolean }> {
    const ns = d.namespace(ctx);
    if (ns) return durableAdmin(ns).entries(q, offset, limit, search);
    return d.local().cores.get(q)!.waitingPage(offset, limit, d.clock.now(), search);
  }

  function liveGames(): LiveRoom[] | null {
    const all = d.rooms();
    if (!all) return null;
    const out: LiveRoom[] = [];
    let n = 0;
    for (const r of all) {
      if (++n > SCAN_CAP) break;
      if (!r.isClosed && roomTypes.includes(r.type)) out.push(r);
    }
    return out;
  }

  const tuning: Schema<QueueTuning> = t.object({
    widenAfterMs: t.integer({ min: 100, max: 3_600_000, description: "Widen the rating window every this many ms" }),
    maxWaitMs: t.integer({ min: 1_000, max: 86_400_000, description: "Give up (status timeout) after this long" }),
    initialWindow: t.number({ min: 0, max: 1_000_000, description: "Starting rating window (± points)" }),
    widenBy: t.number({ min: 0, max: 1_000_000, description: "Added to the window at every step" }),
    maxWindow: t.nullable(t.number({ min: 0, max: 1_000_000, description: "Largest window; null for unlimited" })),
  }) as Schema<QueueTuning>;
  const closeMs = t.union([t.integer({ min: 0, max: 3_600_000 }), t.literal(false)], { description: "Close a finished game room this long after its result; false keeps it open" });

  const settings: ManageSettings<Tuned> = {
    schema: t.object({
      queues: t.object(Object.fromEntries(names.map((n) => [n, tuning]))),
      closeAfterResultMs: t.object(Object.fromEntries(roomTypes.map((r) => [r, closeMs]))),
    }) as unknown as Schema<Tuned>,
    async get(ctx) {
      const queues: Record<string, QueueTuning> = {};
      for (const q of names) queues[q] = (await inspect(ctx, q)).tuning;
      return { queues, closeAfterResultMs: Object.fromEntries(roomTypes.map((r) => [r, closeAfterResultOf(r)])) };
    },
    async set(value, ctx) {
      const ns = d.namespace(ctx);
      for (const [q, tn] of Object.entries(value.queues ?? {})) {
        queueOf(q);
        if (ns) {
          await durableAdmin(ns).configure(q, tn);
        } else {
          d.local().cores.get(q)!.configure(tn);
          d.local().refresh(q);
        }
      }
      for (const [type, ms] of Object.entries(value.closeAfterResultMs ?? {})) if (roomTypes.includes(type)) setCloseAfterResult(type, ms);
    },
  };

  const remove: ManageAction = {
    name: "remove",
    title: "Remove from queue",
    description: "Take this player out of the queue (they can queue again).",
    async run(input: { id?: unknown }, ctx) {
      const s = String(input?.id ?? "");
      const i = s.indexOf(":");
      const q = queueOf(i < 0 ? s : s.slice(0, i));
      const userId = i < 0 ? "" : s.slice(i + 1);
      const left = await d.host(ctx).leave(q, userId);
      return left ? `Removed "${userId}" from queue ${q}.` : `"${userId}" is not waiting in queue ${q}; nothing to do.`;
    },
  };

  const closeFinished: ManageAction = {
    name: "closeFinishedRooms",
    title: "Close finished game rooms now",
    description: "Close in-process game rooms whose result was already reported, instead of waiting for closeAfterResultMs.",
    danger: true,
    run(_input, ctx) {
      let closed = 0;
      for (const r of liveGames() ?? []) {
        if (!isReported(r.room)) continue;
        r.room.broadcast("game.closed", { reason: "game over" });
        r.close("game over");
        closed++;
      }
      const note = ctx.runtime === "workerd" ? " On Cloudflare game rooms are Durable Objects that cannot be listed; they close themselves after closeAfterResultMs." : "";
      return `Closed ${closed} finished game room${closed === 1 ? "" : "s"}.${note}`;
    },
  };

  return [
    {
      id: "matchmaking",
      title: "Matchmaking",
      description: "Queues, wait times and match rate; waiting players; matching knobs.",
      async status(ctx) {
        const onDo = d.namespace(ctx) !== null;
        const rows: Record<string, ManageValue>[] = [];
        let waiting = 0;
        let matches = 0;
        for (const q of names) {
          const { stats } = await inspect(ctx, q);
          waiting += stats.waiting;
          matches += stats.matchesLastMinute;
          rows.push({ queue: q, room: d.queues[q].room, ...stats });
        }
        const games = onDo || ctx.runtime === "workerd" ? null : liveGames();
        const stats: ManageStat[] = [
          { label: "Waiting players", value: waiting, hint: onDo ? "Read from each queue's Durable Object." : "Queues in this process." },
          { label: "Matches in the last minute", value: matches, hint: "Counted in memory by each queue's host since it last started." },
          {
            label: "Long-polls in flight",
            value: onDo ? 0 : d.longPolls(),
            hint: onDo ? "On Cloudflare status reads do not long-poll; clients use the notify WebSocket." : "GET /match/:queue/status?wait= requests waiting in this process.",
          },
          {
            label: "Live game rooms",
            value: games ? games.length : null,
            hint: games ? "In-process rooms of the queues' room types." : "Not available: on Cloudflare every game room is its own Durable Object, which a Worker cannot list.",
          },
        ];
        return {
          stats,
          tables: [
            {
              title: "Queues",
              columns: [
                { key: "queue", label: "Queue" },
                { key: "room", label: "Room type" },
                { key: "waiting", label: "Waiting", type: "number" },
                { key: "oldestWaitMs", label: "Oldest wait", type: "duration" },
                { key: "avgWaitMs", label: "Average wait", type: "duration" },
                { key: "matchesLastMinute", label: "Matches / min", type: "number" },
              ],
              rows,
            },
          ],
        };
      },
      lists: [
        {
          name: "queue",
          title: "Waiting players",
          idKey: "entry",
          searchable: true,
          filters: [{ key: "queue", label: "Queue", options: [...names] }],
          columns: [
            { key: "entry", label: "Entry", type: "code" },
            { key: "queue", label: "Queue" },
            { key: "userId", label: "User", type: "code" },
            { key: "name", label: "Name" },
            { key: "rating", label: "Rating", type: "number" },
            { key: "region", label: "Region" },
            { key: "waitedMs", label: "Waited", type: "duration" },
            { key: "window", label: "Window (±)", type: "number" },
          ],
          async list(q, ctx) {
            const limit = pageSize(q.limit);
            const only = q.filters?.queue;
            const qs = only ? names.filter((n) => n === only) : names;
            const m = /^(\d+):(\d+)$/.exec(q.cursor ?? "");
            let qi = m ? Number(m[1]) : 0;
            let offset = m ? Number(m[2]) : 0;
            const search = q.search?.trim() || undefined;
            const now = d.clock.now();
            const rows: Record<string, ManageValue>[] = [];
            let next: string | undefined;
            for (; qi < qs.length; qi++, offset = 0) {
              const page = await entries(ctx, qs[qi], offset, limit - rows.length, search);
              for (const w of page.rows) {
                rows.push({ entry: `${qs[qi]}:${w.userId}`, queue: qs[qi], userId: w.userId, name: w.name, rating: w.rating, region: w.region, waitedMs: Math.max(0, now - w.joinedAt), window: w.window });
              }
              if (rows.length === limit) {
                if (page.more) next = `${qi}:${offset + page.rows.length}`;
                else if (qi + 1 < qs.length) next = `${qi + 1}:0`;
                break;
              }
            }
            return next === undefined ? { rows } : { rows, next };
          },
          rowActions: [remove],
        },
      ],
      settings: settings as ManageSettings,
      actions: [closeFinished],
    },
  ];
}

// ---- leaderboard ----------------------------------------------------------------------------------

export interface LeaderboardManageDeps {
  id: string;
  sort: "asc" | "desc";
  resets: string;
  mode: string;
  db(env?: Env): Promise<Database>;
  /** The current period key. */
  period(): string;
}

const PERIOD = /^(all|\d{4}-\d{2}(-\d{2})?|\d{4}-W\d{2})$/;

export function leaderboardManage(d: LeaderboardManageDeps): ManageSection[] {
  const better = d.sort === "desc" ? ">" : "<";
  const dir = d.sort === "desc" ? "DESC" : "ASC";

  async function changes(db: Database, sql: string, ...args: unknown[]): Promise<number> {
    const r = (await db.prepare(sql).bind(...args).run()) as { meta?: { changes?: number } };
    return r?.meta?.changes ?? 0;
  }

  return [
    {
      id: "leaderboard",
      title: `Leaderboard "${d.id}"`,
      description: `${d.sort === "desc" ? "High" : "Low"} scores first, ${d.mode} per player, resets ${d.resets}.`,
      async status(ctx) {
        const db = await d.db(ctx.env);
        const period = d.period();
        const row = await db
          .prepare(`SELECT COUNT(*) AS n, ${d.sort === "desc" ? "MAX" : "MIN"}(score) AS top FROM leaderboard_scores WHERE board = ? AND period = ?`)
          .bind(d.id, period)
          .first<{ n: number; top: number | null }>();
        return {
          stats: [
            { label: "Current period", value: period, hint: `Resets ${d.resets}.` },
            { label: "Entries this period", value: row?.n ?? 0 },
            { label: "Top score", value: row?.top ?? null },
          ],
        };
      },
      lists: [
        {
          name: "entries",
          title: "Entries (current period)",
          idKey: "playerId",
          searchable: true,
          columns: [
            { key: "rank", label: "Rank", type: "number" },
            { key: "playerId", label: "Player", type: "code" },
            { key: "name", label: "Name" },
            { key: "score", label: "Score", type: "number" },
            { key: "submissions", label: "Submissions", type: "number" },
            { key: "updatedAt", label: "Updated", type: "date" },
          ],
          async list(q, ctx) {
            const db = await d.db(ctx.env);
            const limit = pageSize(q.limit);
            const offset = /^\d+$/.test(q.cursor ?? "") ? Number(q.cursor) : 0;
            const search = q.search?.trim();
            const where = search ? " AND l.player_id LIKE ? ESCAPE '\\'" : "";
            const args: unknown[] = [d.id, d.period()];
            if (search) args.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
            const { results } = await db
              .prepare(
                `SELECT l.player_id AS playerId, l.score AS score, l.submissions AS submissions, l.updated_at AS updatedAt, p.display_name AS name,
                   (SELECT COUNT(*) FROM leaderboard_scores x WHERE x.board = l.board AND x.period = l.period AND x.score ${better} l.score) + 1 AS rank
                 FROM leaderboard_scores l LEFT JOIN players p ON p.id = l.player_id
                 WHERE l.board = ? AND l.period = ?${where}
                 ORDER BY l.score ${dir}, l.updated_at ASC, l.player_id ASC LIMIT ? OFFSET ?`,
              )
              .bind(...args, limit + 1, offset)
              .all<{ playerId: string; score: number; submissions: number; updatedAt: number; name: string | null; rank: number }>();
            const rows = results.slice(0, limit).map((r) => ({ rank: r.rank, playerId: r.playerId, name: r.name ?? null, score: r.score, submissions: r.submissions, updatedAt: r.updatedAt }));
            return results.length > limit ? { rows, next: String(offset + limit) } : { rows };
          },
          rowActions: [
            {
              name: "remove",
              title: "Remove entry",
              description: "Delete this player's score for the current period.",
              danger: true,
              async run(input: { id?: unknown }, ctx) {
                const player = String(input?.id ?? "");
                const period = d.period();
                const n = await changes(await d.db(ctx.env), "DELETE FROM leaderboard_scores WHERE board = ? AND period = ? AND player_id = ?", d.id, period, player);
                return n ? `Removed "${player}" from ${d.id} (${period}).` : `"${player}" has no entry in ${d.id} (${period}); nothing to do.`;
              },
            },
          ],
        },
      ],
      actions: [
        {
          name: "reset",
          title: "Reset a period",
          description: "Delete every score of a period (default: the current one).",
          danger: true,
          input: t.object({ period: t.optional(t.string({ maxLength: 16, pattern: PERIOD, description: "e.g. 2026-W42, 2026-10-15, 2026-10 or all; empty for the current period" })) }),
          async run(input: { period?: string }, ctx) {
            const period = input?.period || d.period();
            if (!PERIOD.test(period)) throw errors.badRequest(`Invalid period "${period}"`, "Use a key like 2026-W42, 2026-10-15, 2026-10 or all.");
            const n = await changes(await d.db(ctx.env), "DELETE FROM leaderboard_scores WHERE board = ? AND period = ?", d.id, period);
            return `Removed ${n} entr${n === 1 ? "y" : "ies"} from ${d.id} (${period}).`;
          },
        },
      ],
    },
  ];
}
