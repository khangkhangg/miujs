// Ticket-gated game rooms. `gameRoom()` wraps `defineRoom()`:
//
// - adds a `ticket` client message; a player must present the signed ticket the matchmaker or
//   lobby issued before any other game message is accepted (MIU_E_GAME_TICKET_REQUIRED),
// - binds the player to the ticket's user (one live seat per user), runs `onSeat`, sends a
//   `seated` event,
// - keeps seats and the match roster in server-only secret state (survives hibernation),
// - `reportResult(room, ...)` sends the outcome to the ratings store, from the room only.
//
// Wire flow for any client: connect to the room URL, wait for `welcome`, then send
//   {"t":"msg","type":"ticket","data":{"ticket":"<ticket>"}}
// and wait for {"t":"event","event":"seated",...}.

import { t, type Schema } from "miujs";
import { defineRoom, type InitContext, type Player, type Room, type RoomDefinition, type RoomType } from "@miujs/realtime";
import { gameErrors } from "./errors.ts";
import { gameSecret, verifyTicket } from "./sign.ts";
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
  /** Where results go. Default: the matchmaker / lobbies plugin that creates this room type. */
  report?: (matchId: string, result: Result) => Promise<unknown>;
  /** Client messages allowed before a ticket (e.g. chat for spectators). */
  open?: string[];
}

interface GameSecret {
  match: MatchInfo | null;
  seats: Record<string, Seat>;
  reported: boolean;
}

interface Wrapped {
  __game: GameSecret;
  user: unknown;
}

// ---- result sinks (matchmaker / lobbies register themselves per room type) ------------------

type Sink = (matchId: string, result: Result) => Promise<unknown>;
const sinks = new Map<string, Sink[]>();
const options = new Map<string, GameRoomOptions>();

/** @internal Called by matchmaker()/lobbies() for the room types they create. */
export function registerResultSink(roomType: string, fn: Sink): void {
  sinks.set(roomType, [...(sinks.get(roomType) ?? []), fn]);
}

/** The explicit `report` option, else every registered sink in turn until one knows the match. */
function sinkFor(roomType: string): Sink | undefined {
  const explicit = options.get(roomType)?.report;
  if (explicit) return explicit;
  const list = sinks.get(roomType);
  if (!list?.length) return undefined;
  return async (matchId, result) => {
    let last: unknown;
    for (const fn of list) {
      try {
        return await fn(matchId, result);
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
    summary = await sink(g.match.id, mapped);
  } catch (err) {
    g.reported = false;
    throw err;
  }
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
  const key = () => (secret ??= gameSecret(opts.secret));
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
  on.ticket = async ({ room, sender, msg, now }: { room: Room; sender: Player; msg: { ticket: string }; now: number }) => {
    const g = gameOf(room)!;
    const tk = await verifyTicket(key(), msg.ticket, { roomType: type, roomId: room.id, now });
    if (g.match) {
      if (tk.matchId !== g.match.id) throw gameErrors.ticketInvalid("issued for another match");
      if (!g.match.players.some((p) => p.userId === tk.userId)) throw gameErrors.ticketInvalid("user is not in this match");
    }
    const prev = g.seats[sender.id];
    if (prev && prev.userId !== tk.userId) throw gameErrors.ticketInvalid("this connection is already seated as another user");
    for (const [pid, s] of Object.entries(g.seats)) {
      if (s.userId !== tk.userId || pid === sender.id) continue;
      if (room.player(pid)) throw gameErrors.ticketUsed();
      delete g.seats[pid]; // that player left for good; the user takes a new seat
    }
    const seat: Seat = { userId: tk.userId, name: tk.name, team: tk.team, matchId: tk.matchId };
    g.seats[sender.id] = seat;
    if (!prev && def.onSeat) await def.onSeat({ room: facade(room) as Room<S, X>, player: sender, seat: { ...seat }, now });
    room.send(sender.id, "seated", seat);
  };

  const wrapRoom = <F extends (ctx: any) => unknown>(fn: F | undefined) => (fn ? ((ctx: any) => fn({ ...ctx, room: facade(ctx.room) })) : undefined);
  const timers = def.timers ? Object.fromEntries(Object.entries(def.timers).map(([k, fn]) => [k, wrapRoom(fn)!])) : undefined;

  const wrapped: RoomDefinition<S, Wrapped, any> = {
    ...(def as unknown as RoomDefinition<S, Wrapped, any>),
    client: { ...(def.client ?? {}), ticket: t.object({ ticket: t.string({ maxLength: 4096 }) }) },
    init: (ctx) => def.init(ctxOf(ctx)),
    secret: (ctx) => {
      const g = ctxOf(ctx);
      return { __game: { match: g.match ?? null, seats: {}, reported: false }, user: def.secret ? def.secret(g) : undefined };
    },
    onJoin: wrapRoom(def.onJoin as any) as any,
    onLeave: wrapRoom(def.onLeave as any) as any,
    on: on as any,
    timers: timers as any,
  };
  return defineRoom(type, wrapped);
}
