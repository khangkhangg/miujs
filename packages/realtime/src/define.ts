import { errors, type Infer, type Schema } from "miujs";

type MaybePromise<T> = T | Promise<T>;

export type Role = "host" | "player" | "spectator";

export interface Player {
  readonly id: string;
  readonly name: string;
  role: Role;
  /** False while the player is inside the reconnect grace period. */
  connected: boolean;
  readonly joinedAt: number;
}

/** Async key-value storage for a room. In memory locally; Durable Object storage on Cloudflare. */
export interface RoomStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** The room handle every hook and handler receives. */
export interface Room<S = any, X = any> {
  readonly id: string;
  readonly type: string;
  /** Server-authoritative state. Mutate it freely; changes go out as a patch after each handler. */
  state: S;
  /** Server-only state from `secret()`. Never sent to clients. */
  secret: X;
  /** Everyone in the room, including players inside the reconnect grace period. */
  readonly players: readonly Player[];
  player(id: string): Player | undefined;
  /**
   * Send an event to every connected player. `except` skips one player id; `to` picks who gets it
   * (e.g. `{ to: (p) => p.role === "host" }` or a team).
   */
  broadcast(event: string, data?: unknown, opts?: { except?: string; to?: (player: Player) => boolean }): void;
  /** Send an event to one player. */
  send(playerId: string, event: string, data?: unknown): void;
  /**
   * Run the timer handler `name` (declared in `defineRoom({ timers })`) after `delayMs`, with
   * `data` (JSON). Named timers are persisted, so they survive Durable Object hibernation and
   * restarts. Returns the timer id for `cancel()`.
   */
  schedule(name: string, delayMs: number, data?: unknown): string;
  /** Cancel a named timer. Returns false if it already ran or never existed. */
  cancel(timerId: string): boolean;
  /**
   * Run `fn` once after `ms`. Returns a cancel function. Local rooms only: a closure cannot
   * survive Durable Object hibernation, so on Cloudflare this throws; use `schedule()`.
   */
  after(ms: number, fn: () => void | Promise<void>): () => void;
  /** Run `fn` `hz` times per second until cancelled. Local rooms only (see `after`). */
  tick(hz: number, fn: (info: { dt: number; now: number }) => void | Promise<void>): () => void;
  /** Current time from the room clock (ms since epoch; fake in tests). */
  now(): number;
  readonly storage: RoomStorage;
  /**
   * Environment for server code: the Durable Object's `env` (bindings such as D1) on Workers,
   * the process env locally. Read-only by convention.
   */
  readonly env: Record<string, unknown>;
  /**
   * Remove a player now: no reconnect grace, resume token revoked, `onLeave` runs. Their socket
   * (if connected) gets an error frame and closes with `code` (default 4009, terminal for clients).
   * Returns false if there is no such player.
   */
  kick(playerId: string, code?: number, reason?: string): boolean;
  /** Disconnect everyone and dispose the room. */
  close(reason?: string): void;
}

export interface InitContext<D = unknown> {
  id: string;
  type: string;
  /** Data passed when the room was created (if any). */
  data: D | undefined;
  now: number;
}

export interface RoomDefinition<S, X, C extends Record<string, Schema<any>>> {
  /** Schema of the state every client sees. Checked after each handler; bad changes roll back. */
  state: Schema<S>;
  /** Messages clients may send, by type. Payloads are validated before the handler runs. */
  client?: C;
  init(ctx: InitContext): NoInfer<S>;
  /** Server-only state (answers, decks, RNG seeds). Never sent to clients. */
  secret?(ctx: InitContext): X;
  /**
   * Admission check for a new player, before they are seated (not called on resume). Sees every
   * join query parameter (or the join frame's `params`), and may change `player.role` (and other
   * players' roles), e.g. to make a ticket holder the host. Throw (e.g. `errors.forbidden()`) to
   * refuse: the client gets an error frame and the socket closes with 4003. Synchronous.
   */
  onJoinRequest?(ctx: { params: Record<string, string>; player: Player; room: Room<S, X>; now: number }): void;
  onJoin?(ctx: { room: Room<S, X>; player: Player; now: number }): MaybePromise<void>;
  /** A player left for good (reconnect grace over), or was removed with `room.kick()` (`kicked: true`). */
  onLeave?(ctx: { room: Room<S, X>; player: Player; now: number; kicked: boolean }): MaybePromise<void>;
  on?: { [K in keyof C]?: (ctx: { room: Room<S, X>; sender: Player; msg: Infer<C[K]>; now: number }) => MaybePromise<void> };
  /**
   * What one player may see (interest management: hidden hands, fog of war). Each client gets
   * `view(state, player)` instead of the full state, and patches are diffed per view. Must be
   * pure and return JSON; `state` is the committed state (do not mutate it).
   */
  view?: (state: S, player: Player) => unknown;
  /**
   * Named timer handlers for `room.schedule(name, delayMs, data)`. Unlike `after()` closures,
   * these are addressable by name after a restart, so they work on Durable Objects (alarms).
   */
  timers?: Record<string, (ctx: { room: Room<S, X>; data: any; now: number }) => MaybePromise<void>>;
  /**
   * Per-connection inbound frame limit. Default 30 frames/s with a burst of 60. Frames over the
   * limit are dropped (the first drop sends `MIU_E_ROOM_RATE_LIMITED`); a client that stays over
   * the limit for `kickAfterMs` (default 3000) without a quiet second is disconnected (4008).
   * `false` turns it off.
   */
  rateLimit?: { perSecond?: number; burst?: number; kickAfterMs?: number } | false;
  /** Largest accepted inbound frame in bytes. Default 16 384. Bigger frames close the socket (1009). */
  maxMessageBytes?: number;
  /** Max non-spectator players. Default unlimited (but see `maxMembers`). */
  maxPlayers?: number;
  /**
   * Max seats of any role (players, host and spectators). Default 5000. Further joins are refused
   * with `MIU_E_ROOM_FULL` (close 4005), so one client cannot pile thousands of spectators into a
   * room and make every broadcast O(N).
   */
  maxMembers?: number;
  /**
   * A socket must join (`?name=` / `?resume=` or a `join` frame) within this many ms, or it is
   * closed with `MIU_E_ROOM_JOIN_TIMEOUT` (4002). Default 10 000; `0` turns it off.
   */
  joinTimeoutMs?: number;
  /**
   * Host only by key: nobody becomes host by joining first, and no player is promoted when the
   * host leaves. Join with `?role=host&hostKey=<key>` where the key comes from `createRoom()`
   * (server side). Use it whenever the host has powers (start, next, kick). Default false.
   */
  requireHostKey?: boolean;
  /**
   * `false`: only rooms made server side with `createRoom()` exist; connecting to any other id is
   * `404 MIU_E_ROOM_NOT_FOUND` and creates nothing (no rooms conjured by random URLs). Default
   * true (a room is created by its first connection, e.g. chat rooms named in the URL). Not
   * applied to sharded room types.
   */
  createOnJoin?: boolean;
  /** How long a disconnected player keeps their seat. Default 30 000 ms. */
  reconnectMs?: number;
  /**
   * Coalesce presence: the state changes made by joins and leaves (`onJoin`, `onLeave`, kicks,
   * reconnect-grace expiry) reach the other members as at most one patch per window of this many
   * ms (the first one in a quiet period goes out at once). Seating N players then costs O(N)
   * frames per window instead of a patch to everyone per join (O(N²)). A joiner's own first
   * `state` always includes their join. Messages, timers and events flush pending changes first,
   * so ordering is kept. Default 50; 0 patches everyone on every join and leave.
   */
  presenceBatchMs?: number;
  /**
   * Coalesce the state changes of messages and timers the same way: the first change in a quiet
   * period goes out at once, later ones as at most one patch per window of this many ms. For
   * real-time games (inputs at 20-60 Hz from every player) this turns M moves × N players frames
   * into ~N frames per window, at the cost of up to this much extra latency. Events and
   * `room.send` flush pending changes first, so ordering is kept. Default 0 (every change at once).
   */
  patchBatchMs?: number;
}

export interface RoomType<S = any, X = any, C extends Record<string, Schema<any>> = Record<string, Schema<any>>> {
  readonly __miu: "room";
  readonly type: string;
  readonly def: RoomDefinition<S, X, C>;
}

const TYPE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Define a realtime room type.
 *
 * ```ts
 * export const chat = defineRoom("chat", {
 *   state: t.object({ lines: t.array(t.string()) }),
 *   client: { say: t.object({ text: t.string() }) },
 *   init: () => ({ lines: [] }),
 *   on: { say: ({ room, sender, msg }) => { room.state.lines = [...room.state.lines, `${sender.name}: ${msg.text}`]; } },
 * });
 * ```
 */
export function defineRoom<S, X = undefined, C extends Record<string, Schema<any>> = {}>(
  type: string,
  def: RoomDefinition<S, X, C>,
): RoomType<S, X, C> {
  if (!TYPE_RE.test(type)) {
    throw errors.config("MIU_E_ROOM_TYPE_INVALID", `Room type "${type}" is not a valid name`, "Use 1-64 letters, digits, '_' or '-', e.g. defineRoom(\"quiz\", ...).");
  }
  for (const k of Object.keys(def.on ?? {})) {
    if (!def.client || !(k in def.client)) {
      throw errors.config("MIU_E_ROOM_HANDLER_UNKNOWN", `Room "${type}" has a handler on.${k} but no client.${k} schema`, `Add ${k}: t.object({...}) to \`client\`, or remove on.${k}.`);
    }
  }
  return { __miu: "room", type, def };
}
