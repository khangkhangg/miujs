// Matchmaking plugin.
//
//   const mm = matchmaker({
//     rooms: realtime,                                   // the rooms() plugin that hosts matches
//     queues: { ranked: { room: "arena", teamSize: 1, teams: 2, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 120_000 } },
//   });
//
// Routes (auth required):
//   POST   /match/:queue/join     { region? }     → { queue, status }
//   DELETE /match/:queue/leave                    → { queue, left }
//   GET    /match/:queue/status?wait=ms           → { queue, status }   (long-poll while queued)
//   GET    /match/:queue/notify                   → WebSocket: {"t":"match","status":{...}} on every change
//   POST   /match/_result                         → signed results from rooms (internal)
//
// When matched, the status carries `room: { type, id, url }` and a fresh signed `ticket` the room
// verifies before seating the player (see gameRoom()).
//
// Locally queues live in memory and a clock timer re-runs matching at the next window widening.
// On Cloudflare each queue is a Durable Object ("match:<queue>", binding MIU_MATCH): export
// `createMatchmakerDurableObject(mm)` as `MiuMatchmaker`; alarms drive widening and timeouts.

import { definePlugin, route, t, type App, type CloudflareNeeds, type Context, type Env, type MiuSocket } from "miujs";
import type { DatabaseSource } from "@miujs/db";
import { setTimerRef, systemClock, type Clock } from "@miujs/realtime";
import type { AchievementSet } from "./achievements.ts";
import { durableHost, type MatchHost, type NamespaceLike } from "./cloudflare.ts";
import { defaultDatabase, isD1Ref } from "./db.ts";
import { gameErrors } from "./errors.ts";
import { ticketGate } from "./gate.ts";
import { matchmakerManage } from "./manage.ts";
import { QueueCore, checkQueueConfig, type Assignment, type MatchSpec, type QueueConfig, type QueueEntry, type QueueStatus } from "./queue.ts";
import { registerResultSink, type GameRoomData, type MatchInfo } from "./room.ts";
import { gameSecret, hmac, hmacVerify, issueTicket } from "./sign.ts";
import { storeFor, type GameStore, type Result, type ResultSummary } from "./store.ts";

/** The parts of the `rooms()` plugin the matchmaker uses. */
export interface RoomsLike {
  createRoom(type: string, o: { data?: unknown; env?: Record<string, unknown>; code: false }): Promise<{ id: string }>;
  registry: { has(type: string): boolean; instances?(): Iterable<{ type: string; isClosed: boolean; room: any; close(reason?: string): void }> };
  /** Route prefix of the rooms plugin, e.g. `/rooms`. */
  path?: string;
  inspect?(): unknown;
}

/** The rooms plugin's route prefix (its `path`, or parsed from inspect() on older versions). */
export function roomsPathOf(rooms: RoomsLike): string {
  if (typeof rooms.path === "string") return rooms.path;
  const p = (rooms.inspect?.() as { path?: string } | undefined)?.path;
  return typeof p === "string" ? p.replace(/\/:type\/:id$/, "") : "/rooms";
}

export interface MatchmakerOptions {
  rooms: RoomsLike;
  queues: Record<string, QueueConfig>;
  /** Ticket / result signing secret. Default MIU_GAME_SECRET (or a per-process dev secret off Workers). */
  secret?: string;
  /** Profiles, ratings and matches. Default: D1 "DB" on Workers, shared in-memory SQLite elsewhere. */
  database?: DatabaseSource;
  achievements?: AchievementSet;
  /** Elo K factor. Default 32. */
  k?: number;
  /** How long a ticket stays valid. Default 60 s. A fresh one is minted on every status read. */
  ticketTtlMs?: number;
  /** Longest long-poll wait. Default 25 s. */
  longPollMs?: number;
  /** Route prefix. Default `/match`. */
  path?: string;
  /** Durable Object binding / class for Cloudflare. Default MIU_MATCH / MiuMatchmaker. */
  binding?: string;
  className?: string;
  clock?: Clock;
}

/** Status as clients see it (`matched` carries a fresh ticket). */
export type PublicStatus = QueueStatus;

const INTERNAL = Symbol.for("miujs.game.matchmaker");

export interface MatchmakerInternals {
  queues: Record<string, QueueConfig>;
  clock: Clock;
  secret(): string;
  createMatch(spec: MatchSpec, env: Env | undefined): Promise<Record<string, Assignment>>;
  present(status: QueueStatus, userId: string): Promise<QueueStatus>;
}

// ---- local host -------------------------------------------------------------------------------

class LocalHost implements MatchHost {
  readonly cores = new Map<string, QueueCore>();
  private listeners = new Map<string, Set<(s: QueueStatus) => void>>();
  private wake: unknown = null;
  private wakeAt: number | null = null;
  private inner: MatchmakerInternals;

  constructor(inner: MatchmakerInternals) {
    this.inner = inner;
    for (const [name, cfg] of Object.entries(inner.queues)) this.cores.set(name, new QueueCore(name, cfg));
  }

  async join(queue: string, entry: QueueEntry): Promise<QueueStatus> {
    const core = this.cores.get(queue)!;
    core.join(entry, this.inner.clock.now());
    this.emit(queue, entry.userId);
    this.pump(queue);
    return core.status(entry.userId, this.inner.clock.now());
  }

  async leave(queue: string, userId: string): Promise<boolean> {
    const left = this.cores.get(queue)!.leave(userId);
    if (left) this.emit(queue, userId);
    this.rearm();
    return left;
  }

  async status(queue: string, userId: string): Promise<QueueStatus> {
    return this.cores.get(queue)!.status(userId, this.inner.clock.now());
  }

  subscribe(queue: string, userId: string, fn: (s: QueueStatus) => void): () => void {
    const k = `${queue}\u0000${userId}`;
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(k);
    };
  }

  private emit(queue: string, userId: string): void {
    const set = this.listeners.get(`${queue}\u0000${userId}`);
    if (!set) return;
    const s = this.cores.get(queue)!.status(userId, this.inner.clock.now());
    for (const fn of [...set]) fn(s);
  }

  /** Re-run matching for a queue now (after its knobs changed). */
  refresh(queue: string): void {
    this.pump(queue);
  }

  /** Run matching for one queue now; create rooms for new matches. */
  private pump(queue: string): void {
    const core = this.cores.get(queue)!;
    const now = this.inner.clock.now();
    const { matches, timedOut } = core.run(now);
    for (const u of timedOut) this.emit(queue, u);
    for (const m of matches) {
      for (const p of m.players) this.emit(queue, p.userId);
      void this.inner.createMatch(m, undefined).then(
        (assignments) => {
          core.assign(m.id, assignments, this.inner.clock.now());
          for (const p of m.players) this.emit(queue, p.userId);
          this.rearm();
        },
        (err) => {
          console.error(`[miujs/game] creating match ${m.id} failed:`, err);
          core.fail(m.id, m.players.map((p) => p.userId), String((err as Error)?.message ?? err), this.inner.clock.now());
          for (const p of m.players) this.emit(queue, p.userId);
        },
      );
    }
    this.rearm();
  }

  /** One clock timer at the earliest moment any queue could change (widening, timeout, expiry). */
  private rearm(): void {
    const now = this.inner.clock.now();
    let due: number | null = null;
    for (const c of this.cores.values()) {
      const d = c.nextDue(now);
      if (d !== null && (due === null || d < due)) due = d;
    }
    if (due === this.wakeAt) return;
    if (this.wake !== null) this.inner.clock.clearTimeout(this.wake);
    this.wake = null;
    this.wakeAt = due;
    if (due === null) return;
    this.wake = this.inner.clock.setTimeout(() => {
      this.wake = null;
      this.wakeAt = null;
      for (const q of this.cores.keys()) this.pump(q);
    }, due - now);
    // Queue upkeep (widening, time-outs, status expiry) never keeps the process alive by itself:
    // a running server already does, and a stopped one should exit.
    setTimerRef(this.wake, false);
  }

  /** Clear the wake-up timer (shutdown). */
  stop(): void {
    if (this.wake !== null) this.inner.clock.clearTimeout(this.wake);
    this.wake = null;
    this.wakeAt = null;
  }
}

function nsFrom(ctx: Context, binding: string): NamespaceLike | null {
  if (ctx.runtime !== "workerd") return null;
  const ns = ctx.env?.[binding] as NamespaceLike | undefined;
  return ns && typeof ns.idFromName === "function" ? ns : null;
}

// ---- signed results -------------------------------------------------------------------------------

const RESULT_SKEW_MS = 60_000;

/** Sign a room result for `POST /match/_result` (for rooms that cannot call reportResult directly). */
export async function signResult(secret: string, payload: { matchId: string; result: Result }, now: number): Promise<{ body: string; headers: Record<string, string> }> {
  const body = JSON.stringify({ matchId: payload.matchId, result: payload.result, at: now });
  return { body, headers: { "content-type": "application/json", "x-miu-signature": await hmac(`result:${secret}`, body) } };
}

/** A `report` function for gameRoom() that POSTs signed results to `url` (e.g. https://app.example/match/_result). */
export function resultReporter(url: string, o: { secret?: string; clock?: Clock; fetch?: typeof fetch } = {}) {
  return async (matchId: string, result: Result): Promise<unknown> => {
    const s = await signResult(gameSecret(o.secret), { matchId, result }, (o.clock ?? systemClock).now());
    const res = await (o.fetch ?? fetch)(url, { method: "POST", body: s.body, headers: s.headers });
    if (!res.ok) throw new Error(`result report failed: ${res.status} ${await res.text()}`);
    return res.json();
  };
}

// ---- the plugin -------------------------------------------------------------------------------------

export function matchmaker(opts: MatchmakerOptions) {
  const clock = opts.clock ?? systemClock;
  const prefix = (opts.path ?? "/match").replace(/\/+$/, "");
  const binding = opts.binding ?? "MIU_MATCH";
  const className = opts.className ?? "MiuMatchmaker";
  const ticketTtl = opts.ticketTtlMs ?? 60_000;
  const longPoll = opts.longPollMs ?? 25_000;
  const source = opts.database ?? defaultDatabase();
  const names = Object.keys(opts.queues);
  for (const [name, cfg] of Object.entries(opts.queues)) {
    checkQueueConfig(name, cfg);
    if (!opts.rooms.registry.has(cfg.room)) {
      throw gameErrors.queueConfig(`Queue "${name}" uses room type "${cfg.room}", which the rooms plugin does not host`, `Add it: rooms({ rooms: [${cfg.room}] }), and pass that plugin as matchmaker({ rooms }).`);
    }
  }
  const roomsPath = roomsPathOf(opts.rooms);
  let lastEnv: Env = {};
  let secret: string | null = null;
  const key = () => (secret ??= gameSecret(opts.secret));
  const store = (env?: Env): GameStore => storeFor(source, env ?? lastEnv, { clock, k: opts.k, achievements: opts.achievements });

  const inner: MatchmakerInternals = {
    queues: opts.queues,
    clock,
    secret: key,
    async createMatch(spec, env) {
      const cfg = opts.queues[spec.queue];
      const info: MatchInfo = { id: spec.id, queue: spec.queue, rated: true, players: spec.players.map(({ userId, name, team }) => ({ userId, name, team })), teams: spec.teams };
      const data: GameRoomData = { match: info };
      const { id } = await opts.rooms.createRoom(cfg.room, env ? { data, env: env as Record<string, unknown>, code: false } : { data, code: false });
      await store(env).createMatch(spec, cfg.rating, id);
      const room = { type: cfg.room, id, url: `${roomsPath}/${cfg.room}/${id}` };
      const out: Record<string, Assignment> = {};
      for (const p of spec.players) {
        out[p.userId] = { room, team: p.team, ticket: await issueTicket(key(), { userId: p.userId, name: p.name, roomType: cfg.room, roomId: id, matchId: spec.id, team: p.team }, clock.now(), ticketTtl) };
      }
      return out;
    },
    /** A matched status with a freshly minted ticket (tickets are short-lived; statuses are not). */
    async present(status, userId) {
      if (status.state !== "matched") return status;
      const m = await store().match(status.matchId).catch(() => null);
      const name = m?.players.find((x) => x.userId === userId)?.name ?? userId;
      const ticket = await issueTicket(key(), { userId, name, roomType: status.room.type, roomId: status.room.id, matchId: status.matchId, team: status.team }, clock.now(), ticketTtl);
      return { ...status, ticket };
    },
  };

  let local: LocalHost | null = null;
  const localHost = () => (local ??= new LocalHost(inner));
  const host = (ctx: Context): MatchHost => {
    const ns = nsFrom(ctx, binding);
    return ns ? durableHost(ns) : localHost();
  };
  const queueOf = (q: string) => {
    if (!Object.prototype.hasOwnProperty.call(opts.queues, q)) throw gameErrors.queueUnknown(q, names);
    return opts.queues[q];
  };

  async function reportResult(matchId: string, result: Result, env?: Env): Promise<ResultSummary> {
    return store(env).reportResult(matchId, result);
  }
  // Rooms report with their own env (room.env: D1 on Workers), so this works inside a Durable Object.
  const unregister = Object.values(opts.queues).map((cfg) => registerResultSink(cfg.room, (m, r, env) => reportResult(m, r, env)));
  /** Long-polls waiting on a status; stop() answers them. */
  const waiting = new Set<() => void>();

  const queueParam = t.object({ queue: t.string({ maxLength: 64 }) });
  const routes = [
    route.post(`${prefix}/:queue/join`, {
      name: "match_join",
      summary: "Join a matchmaking queue; poll status (or open the notify WebSocket) until matched",
      tags: ["game"],
      auth: "required",
      params: queueParam,
      body: t.object({ region: t.optional(t.string({ maxLength: 32 })) }),
      handler: async (ctx) => {
        const { params, body, user, env } = ctx;
        queueOf(params.queue);
        const s = store(env);
        const profile = await s.ensurePlayer(user.id, typeof user.name === "string" && user.name ? user.name : user.id);
        const r = await s.rating(user.id, params.queue);
        const entry: QueueEntry = { userId: user.id, name: profile.displayName, rating: r.rating };
        if (body.region !== undefined) entry.region = body.region;
        const status = await host(ctx as unknown as Context).join(params.queue, entry);
        return { queue: params.queue, status: await inner.present(status, user.id) };
      },
    }),
    route.delete(`${prefix}/:queue/leave`, {
      name: "match_leave",
      summary: "Leave a matchmaking queue",
      tags: ["game"],
      auth: "required",
      params: queueParam,
      handler: async (ctx) => {
        queueOf(ctx.params.queue);
        return { queue: ctx.params.queue, left: await host(ctx as unknown as Context).leave(ctx.params.queue, ctx.user.id) };
      },
    }),
    route.get(`${prefix}/:queue/status`, {
      name: "match_status",
      summary: "Your matchmaking status: queued, matched (room + ticket), timeout or idle. ?wait=ms long-polls",
      tags: ["game"],
      auth: "required",
      params: queueParam,
      query: t.object({ wait: t.optional(t.integer({ min: 0, max: 60_000 })) }),
      handler: async (ctx) => {
        const q = ctx.params.queue;
        queueOf(q);
        const h = host(ctx as unknown as Context);
        let status = await h.status(q, ctx.user.id);
        const wait = Math.min(ctx.query.wait ?? 0, longPoll);
        if (wait > 0 && h instanceof LocalHost && (status.state === "queued" || status.state === "matching")) {
          status = await new Promise<QueueStatus>((resolve) => {
            let timer: unknown = null;
            const signal = ctx.req.signal;
            const done = () => {
              clock.clearTimeout(timer);
              unsub();
              waiting.delete(timeout);
              signal?.removeEventListener("abort", timeout);
            };
            const unsub = h.subscribe(q, ctx.user.id, (s) => {
              if (s.state === "queued" || s.state === "matching") return;
              done();
              resolve(s);
            });
            const timeout = () => {
              done();
              void h.status(q, ctx.user.id).then(resolve);
            };
            timer = clock.setTimeout(timeout, wait);
            waiting.add(timeout);
            // The client went away: stop waiting now instead of holding the subscription for `wait` ms.
            if (signal?.aborted) timeout();
            else signal?.addEventListener("abort", timeout, { once: true });
          });
        }
        return { queue: q, status: await inner.present(status, ctx.user.id) };
      },
    }),
    route.get(`${prefix}/:queue/notify`, {
      name: "match_notify",
      summary: "WebSocket that pushes your matchmaking status for a queue",
      tags: ["game"],
      auth: "required",
      mcp: false,
      params: queueParam,
      handler: async (ctx) => {
        const q = ctx.params.queue;
        queueOf(q);
        const ns = nsFrom(ctx as unknown as Context, binding);
        if (ns) {
          const headers = new Headers(ctx.req.headers);
          headers.set("x-miu-user", ctx.user.id);
          return ns.get(ns.idFromName(`match:${q}`)).fetch(new Request(`https://miu-match/_miu/match/notify?queue=${encodeURIComponent(q)}`, { headers }));
        }
        const h = localHost();
        const userId = ctx.user.id;
        let unsub: (() => void) | null = null;
        const push = async (socket: MiuSocket, s: QueueStatus) => {
          try {
            socket.send(JSON.stringify({ t: "match", queue: q, status: await inner.present(s, userId) }));
          } catch {}
        };
        return ctx.upgrade({
          open(socket) {
            unsub = h.subscribe(q, userId, (s) => void push(socket, s));
            void h.status(q, userId).then((s) => push(socket, s));
          },
          message(socket, m) {
            if (String(m).includes('"ping"')) socket.send(JSON.stringify({ t: "pong" }));
          },
          close() {
            unsub?.();
          },
        });
      },
    }),
    route.post(`${prefix}/_result`, {
      name: "match_result",
      summary: "Signed match results from game rooms",
      internal: true,
      mcp: false,
      handler: async (ctx) => {
        const raw = await ctx.req.text();
        const sig = ctx.headers.get("x-miu-signature") ?? "";
        if (!sig || !(await hmacVerify(`result:${key()}`, raw, sig))) throw gameErrors.resultUnsigned();
        let p: { matchId?: unknown; result?: unknown; at?: unknown };
        try {
          p = JSON.parse(raw);
        } catch {
          throw gameErrors.resultUnsigned();
        }
        if (typeof p.at !== "number" || Math.abs(clock.now() - p.at) > RESULT_SKEW_MS || typeof p.matchId !== "string") throw gameErrors.resultUnsigned();
        return reportResult(p.matchId, p.result as Result, ctx.env);
      },
    }),
  ];

  const gate = ticketGate({ roomsPath, types: () => Object.values(opts.queues).map((q) => q.room), secret: key, clock });

  const plugin = definePlugin({
    name: "matchmaker",
    routes,
    setup(app: App) {
      app.provide("matchmaker", plugin);
    },
    onRequest(ctx: Context) {
      lastEnv = ctx.env;
      return gate(ctx);
    },
    inspect: () => ({
      path: prefix,
      roomsPath,
      queues: Object.fromEntries(
        Object.entries(opts.queues).map(([n, c]) => [n, { teams: 2, ...c, waiting: local?.cores.get(n)?.size ?? 0 }]),
      ),
      ticketTtlMs: ticketTtl,
      longPolls: waiting.size,
      durableObject: { binding, className },
      routes: routes.filter((r) => !r.config.internal).map((r) => `${r.method} ${r.path}`),
    }),
    /** Operator view for @miujs/admin: queues, waiting players, matching knobs. */
    manage: () =>
      matchmakerManage({
        queues: opts.queues,
        clock,
        local: localHost,
        namespace: (ctx: Context) => nsFrom(ctx, binding),
        host,
        longPolls: () => waiting.size,
        rooms: () => opts.rooms.registry.instances?.() ?? null,
      }),
    cloudflare: (): CloudflareNeeds => {
      const needs: CloudflareNeeds = { durableObjects: [{ binding, className }] };
      if (isD1Ref(source)) needs.d1 = [source.binding];
      return needs;
    },
    /** Apply a match result (server side only). */
    reportResult,
    /**
     * Shutdown: clear the local queue timer, answer pending long-polls and unregister this
     * matchmaker's result sinks. Call it after `server.stop()`.
     */
    stop(): void {
      local?.stop();
      for (const finish of [...waiting]) finish();
      for (const off of unregister.splice(0)) off();
    },
    /** The store for profiles, ratings and matches (pass `env` on Workers). */
    store,
    [INTERNAL]: inner,
  });
  return plugin;
}

export type Matchmaker = ReturnType<typeof matchmaker>;

