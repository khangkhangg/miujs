// Ticket-gated game rooms. `gameRoom()` wraps `defineRoom()`:
//
// - admission happens in realtime's `onJoinRequest`, before seating. A join must carry the signed
//   ticket the matchmaker or lobby issued (`?ticket=`, or `params.ticket` in a join frame).
//   Otherwise it is refused (close 4003) and takes no seat. Spectators may opt in with
//   `{ spectators: true }`.
// - the ticket must be for this room (a shard `id:shardN` counts as its base id), this match and a
//   rostered user. Each user gets one live seat. Then `onSeat` runs and a `seated` event goes out.
// - the `ticket` client message still works for clients that join without params (a no-op
//   once seated).
// - seats and the match roster live in server-only secret state, so they survive hibernation.
// - `reportResult(room, ...)` sends the outcome to the ratings store with `room.env`, from the
//   room only.
//
// Resumes (?resume=<token>) keep the seat and need no ticket.

import { t, type Schema } from "miujs";
import { defineRoom, parseShardId, type InitContext, type Player, type Room, type RoomDefinition, type RoomType } from "@miujs/realtime";
import { gameErrors } from "./errors.ts";
import { gameSecretFor, verifyTicketSync } from "./sign.ts";
import type { Result, ResultSummary } from "./store.ts";

type MaybePromise<T> = T | Promise<T>;

export interface MatchInfo {
  id: string;
  /** Queue name, or `lobby`. */
  queue: string;
  /** False for unrated (lobby) matches. */
  rated: boolean;
  players: { userId: string; name: string; team: number }[];
  teams: string[][];
}

export interface Seat {
  userId: string;
  name: string;
  team: number;
  matchId: string;
}

/** What the matchmaker / lobby passes as room creation data. */
export interface GameRoomData {
  match?: MatchInfo;
  data?: unknown;
}

export type GameInitContext = InitContext & { match: MatchInfo | undefined };

export interface GameRoomDefinition<S, X, C extends Record<string, Schema<any>>> extends Omit<RoomDefinition<S, X, C>, "init" | "secret"> {
  /** Initial state. `ctx.match` holds the roster when the matchmaker or a lobby created the room. */
  init(ctx: GameInitContext): NoInfer<S>;
  secret?(ctx: GameInitContext): X;
  /** A player presented a valid ticket and now plays for `seat.userId`. */
  onSeat?(ctx: { room: Room<S, X>; player: Player; seat: Seat; now: number }): MaybePromise<void>;
}

export interface GameRoomOptions {
  /** Ticket signing secret. Default: MIU_GAME_SECRET, or a per-process dev secret off Workers. */
  secret?: string;
  /**
   * Where results go. Default: the matchmaker / lobbies plugin that creates this room type, which
   * reaches the database through `room.env` (D1 on Workers). `resultReporter(url)` is an option.
   */
  report?: (matchId: string, result: Result, env: Record<string, unknown>) => Promise<unknown>;
  /** Client messages allowed without a seat (e.g. chat for spectators). */
  open?: string[];
  /** Let `role=spectator` joins in without a ticket (they get no seat). Default false. */
  spectators?: boolean;
  /**
   * Close the room this long after `reportResult()` (game over), after a final `game.closed`
   * event, so finished games free their memory instead of lingering through the reconnect grace
   * and empty-room timeout. A named timer, so it also fires on Durable Objects. Default 5000;
   * `false` keeps the room open (e.g. for rematches).
   */
  closeAfterResultMs?: number | false;
}

/** Named timer that closes a finished game room. */
export const CLOSE_TIMER = "__miu_game_close";

interface GameSecret {
  match: MatchInfo | null;
  seats: Record<string, Seat>;
  reported: boolean;
  /** Admitted by onJoinRequest, onSeat not run yet. */
  pending?: string[];
  /** Users removed with room.kick(): their tickets are refused for the rest of the match. */
  banned?: string[];
}

interface Wrapped {
  __game: GameSecret;
  user: unknown;
}

// ---- result sinks (matchmaker / lobbies register themselves per room type) ------------------

type Sink = (matchId: string, result: Result, env: Record<string, unknown>) => Promise<unknown>;
const sinks = new Map<string, Sink[]>();
const options = new Map<string, GameRoomOptions>();

/**
 * @internal Called by matchmaker()/lobbies() for the room types they create. Returns the
 * unregister function their `stop()` calls, so plugins made and dropped (tests, hot reload) do not
 * pile up here with their stores.
 */
export function registerResultSink(roomType: string, fn: Sink): () => void {
  sinks.set(roomType, [...(sinks.get(roomType) ?? []), fn]);
  return () => {
    const rest = (sinks.get(roomType) ?? []).filter((x) => x !== fn);
    if (rest.length) sinks.set(roomType, rest);
    else sinks.delete(roomType);
  };
}

/** The explicit `report` option, else every registered sink in turn until one knows the match. */
function sinkFor(roomType: string): Sink | undefined {
  const explicit = options.get(roomType)?.report;
  if (explicit) return explicit;
  const list = sinks.get(roomType);
  if (!list?.length) return undefined;
  return async (matchId, result, env) => {
    let last: unknown;
    for (const fn of list) {
      try {
        return await fn(matchId, result, env);
      } catch (err) {
        if ((err as { code?: string })?.code !== "MIU_E_GAME_MATCH_UNKNOWN") throw err;
        last = err;
      }
    }
    throw last;
  };
}

// ---- facade: user handlers see their own secret, not the wrapper ------------------------------

const RAW = Symbol.for("miujs.game.rawRoom");
const facades = new WeakMap<object, Room>();

function raw(room: Room): Room {
  return ((room as any)[RAW] as Room | undefined) ?? room;
}

function facade(room: Room): Room {
  const r = raw(room);
  let f = facades.get(r);
  if (!f) {
    f = Object.create(r, {
      secret: {
        get: () => (r.secret as Wrapped).user,
        set: (v) => void ((r.secret as Wrapped).user = v),
        enumerable: true,
      },
      [RAW]: { value: r },
    }) as Room;
    facades.set(r, f);
  }
  return f;
}

function gameOf(room: Room): GameSecret | undefined {
  const s = raw(room).secret as Wrapped | undefined;
  return s && typeof s === "object" && "__game" in s ? s.__game : undefined;
}

/** The seat (user, team) a player took with their ticket. */
export function seatOf(room: Room, playerId: string): Seat | undefined {
  const s = gameOf(room)?.seats[playerId];
  return s ? { ...s } : undefined;
}

/** Every seat by player id. */
export function seats(room: Room): Record<string, Seat> {
  return structuredClone(gameOf(room)?.seats ?? {});
}

/** The match this room was created for (roster and teams), if any. */
export function matchOf(room: Room): MatchInfo | undefined {
  const m = gameOf(room)?.match;
  return m ? structuredClone(m) : undefined;
}

/** True once `reportResult()` succeeded for this room (the game is over). */
export function isReported(room: Room): boolean {
  return gameOf(room)?.reported === true;
}

/** @internal The game room type's `closeAfterResultMs` in this isolate (default 5000). */
export function closeAfterResultOf(type: string): number | false {
  return options.get(type)?.closeAfterResultMs ?? 5_000;
}

/** @internal Change `closeAfterResultMs` for a game room type at runtime (used by manage()). */
export function setCloseAfterResult(type: string, ms: number | false): void {
  options.set(type, { ...options.get(type), closeAfterResultMs: ms });
}

/**
 * Report the match outcome from the authoritative room. Ids may be player ids (mapped through
 * seats) or user ids of the roster. Only the first report counts. `summary` is what the store
 * returned (rating changes and achievement unlocks), handy for a game-over broadcast.
 */
export async function reportResult<T = ResultSummary>(room: Room, result: { winners: string[] } | { ranking: string[][] }): Promise<{ reported: boolean; result?: Result; summary?: T }> {
  const g = gameOf(room);
  if (!g?.match) throw gameErrors.matchUnknown("(this room was not created for a match)");
  if (g.reported) return { reported: false };
  const roster = new Set(g.match.players.map((p) => p.userId));
  const toUser = (id: string) => {
    const u = g.seats[id]?.userId ?? (roster.has(id) ? id : undefined);
    if (!u) throw gameErrors.resultInvalid(`"${id}" did not play in this match`);
    return u;
  };
  const r = result as { winners?: string[]; ranking?: string[][] };
  const mapped: Result = Array.isArray(r.ranking) ? { ranking: r.ranking.map((g) => g.map(toUser)) } : { winners: (r.winners ?? []).map(toUser) };
  const sink = sinkFor(room.type);
  if (!sink) throw gameErrors.storeMissing(`reportResult() in room "${room.type}"`);
  g.reported = true;
  let summary: unknown;
  try {
    summary = await sink(g.match.id, mapped, raw(room).env ?? {});
  } catch (err) {
    g.reported = false;
    throw err;
  }
  const closeMs = options.get(room.type)?.closeAfterResultMs ?? 5_000;
  if (closeMs !== false) raw(room).schedule(CLOSE_TIMER, closeMs);
  return { reported: true, result: mapped, summary: summary as T };
}

// ---- the wrapper --------------------------------------------------------------------------------

/** Define a ticket-gated realtime room for matchmaker / lobby matches. Same options as `defineRoom`. */
export function gameRoom<S, X = undefined, C extends Record<string, Schema<any>> = {}>(type: string, def: GameRoomDefinition<S, X, C>, opts: GameRoomOptions = {}): RoomType<S, Wrapped, any> {
  if (def.client && Object.prototype.hasOwnProperty.call(def.client, "ticket")) {
    throw gameErrors.roomConfig(`gameRoom("${type}") declares a client message named "ticket"`, "Rename it: `ticket` is how players present their match ticket.");
  }
  options.set(type, opts);
  let secret: string | null = null;
  // room.env: the Durable Object's env on Workers, where MIU_GAME_SECRET lives.
  const key = (env?: Record<string, unknown>) => (secret ??= gameSecretFor(opts.secret, env));
  const open = new Set(opts.open ?? []);
  const ctxOf = (ctx: InitContext): GameInitContext => {
    const d = (ctx.data ?? {}) as GameRoomData;
    return { ...ctx, data: d.data, match: d.match };
  };

  const on: Record<string, (ctx: any) => unknown> = {};
  for (const [name, handler] of Object.entries((def.on ?? {}) as Record<string, (ctx: any) => unknown>)) {
    on[name] = (ctx) => {
      if (!open.has(name) && !gameOf(ctx.room)?.seats[ctx.sender.id]) throw gameErrors.ticketRequired();
      return handler({ ...ctx, room: facade(ctx.room) });
    };
  }
  /**
   * Check a ticket and bind its user to `playerId`: signature, this room (a shard `id:shardN`
   * counts as its base id), match, roster, and one live seat per user. Synchronous, so it runs in
   * realtime's onJoinRequest, before the player is seated at all.
   */
  const admit = (room: Room, playerId: string, ticket: unknown, now: number): { seat: Seat; fresh: boolean } => {
    const g = gameOf(room)!;
    const roomId = parseShardId(room.id)?.id ?? room.id;
    const tk = verifyTicketSync(key((room as { env?: Record<string, unknown> }).env), ticket, { roomType: type, roomId, now });
    if (g.match) {
      if (tk.matchId !== g.match.id) throw gameErrors.ticketInvalid("issued for another match");
      if (!g.match.players.some((p) => p.userId === tk.userId)) throw gameErrors.ticketInvalid("user is not in this match");
    }
    if (g.banned?.includes(tk.userId)) throw gameErrors.ticketInvalid("this user was removed from the match");
    const prev = g.seats[playerId];
    if (prev) {
      if (prev.userId !== tk.userId) throw gameErrors.ticketInvalid("this connection is already seated as another user");
      return { seat: prev, fresh: false };
    }
    for (const [pid, s] of Object.entries(g.seats)) {
      if (s.userId !== tk.userId) continue;
      if (room.player(pid)) throw gameErrors.ticketUsed();
      delete g.seats[pid]; // that player left for good; the user takes a new seat
    }
    const seat: Seat = { userId: tk.userId, name: tk.name, team: tk.team, matchId: tk.matchId };
    g.seats[playerId] = seat;
    return { seat, fresh: true };
  };
  /** The ticket names the player (from their profile): `?name=` cannot impersonate the opponent. */
  const nameFromTicket = (player: Player, seat: Seat) => {
    const name = seat.name.trim().slice(0, 32);
    if (name) (player as { name: string }).name = name;
  };
  const seatNow = async (room: Room, player: Player, seat: Seat, now: number) => {
    if (def.onSeat) await def.onSeat({ room: facade(room) as Room<S, X>, player, seat: { ...seat }, now });
    room.send(player.id, "seated", seat);
  };

  // The ticket message: for clients that join without params. Once seated it is a silent no-op.
  on.ticket = async ({ room, sender, msg, now }: { room: Room; sender: Player; msg: { ticket: string }; now: number }) => {
    const { seat, fresh } = admit(room, sender.id, msg.ticket, now);
    if (fresh) {
      nameFromTicket(sender, seat);
      await seatNow(room, sender, seat, now);
    }
  };

  const wrapRoom = <F extends (ctx: any) => unknown>(fn: F | undefined) => (fn ? ((ctx: any) => fn({ ...ctx, room: facade(ctx.room) })) : undefined);
  const timers: Record<string, (ctx: any) => unknown> = def.timers ? Object.fromEntries(Object.entries(def.timers).map(([k, fn]) => [k, wrapRoom(fn)!])) : {};
  timers[CLOSE_TIMER] = ({ room }: { room: Room }) => {
    room.broadcast("game.closed", { reason: "game over" });
    room.close("game over");
  };

  const wrapped: RoomDefinition<S, Wrapped, any> = {
    ...(def as unknown as RoomDefinition<S, Wrapped, any>),
    // Seats come from tickets, so nobody is host by joining first (a game may still make a
    // player host in onJoinRequest), and rooms exist only once the matchmaker or a lobby made
    // them: a random URL (e.g. ?resume=junk) cannot conjure one.
    requireHostKey: def.requireHostKey ?? true,
    createOnJoin: def.createOnJoin ?? false,
    client: { ...(def.client ?? {}), ticket: t.object({ ticket: t.string({ maxLength: 4096 }) }) },
    init: (ctx) => def.init(ctxOf(ctx)),
    secret: (ctx) => {
      const g = ctxOf(ctx);
      return { __game: { match: g.match ?? null, seats: {}, reported: false }, user: def.secret ? def.secret(g) : undefined };
    },
    onJoinRequest: (ctx) => {
      const ticket = ctx.params.ticket;
      let admitted: { seat: Seat; fresh: boolean } | null = null;
      if (ticket !== undefined) {
        admitted = admit(ctx.room, ctx.player.id, ticket, ctx.now);
        nameFromTicket(ctx.player, admitted.seat);
      } else if (!(opts.spectators && ctx.player.role === "spectator")) {
        throw gameErrors.ticketRequired();
      }
      // The room's own hook may still refuse the join: record the seat as pending only once it
      // accepts, so a refused join leaves no seat or pending entry behind.
      try {
        def.onJoinRequest?.({ ...ctx, room: facade(ctx.room) as any });
      } catch (err) {
        if (admitted?.fresh) delete gameOf(ctx.room)!.seats[ctx.player.id];
        throw err;
      }
      if (admitted) {
        const g = gameOf(ctx.room)!;
        g.pending = [...(g.pending ?? []), ctx.player.id];
      }
    },
    onJoin: async (ctx) => {
      const g = gameOf(ctx.room)!;
      if (g.pending?.includes(ctx.player.id)) {
        g.pending = g.pending.filter((id) => id !== ctx.player.id);
        const seat = g.seats[ctx.player.id];
        if (seat) await seatNow(ctx.room, ctx.player, seat, ctx.now);
      }
      if (def.onJoin) await (def.onJoin as any)({ ...ctx, room: facade(ctx.room) });
    },
    onLeave: (ctx: { room: Room; player: Player; now: number; kicked: boolean }) => {
      const g = gameOf(ctx.room);
      const seat = g?.seats[ctx.player.id];
      // Kicked: that user stays out, even with a fresh ticket from the matchmaker or lobby.
      if (g && seat && ctx.kicked && !g.banned?.includes(seat.userId)) g.banned = [...(g.banned ?? []), seat.userId];
      return def.onLeave ? (def.onLeave as any)({ ...ctx, room: facade(ctx.room) }) : undefined;
    },
    on: on as any,
    timers: timers as any,
  };
  return defineRoom(type, wrapped);
}
