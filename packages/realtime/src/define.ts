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
  /** Send an event to every connected player (optionally skipping one). */
  broadcast(event: string, data?: unknown, opts?: { except?: string }): void;
  /** Send an event to one player. */
  send(playerId: string, event: string, data?: unknown): void;
  /** Run `fn` once after `ms`. Returns a cancel function. */
  after(ms: number, fn: () => void | Promise<void>): () => void;
  /** Run `fn` `hz` times per second until cancelled. */
  tick(hz: number, fn: (info: { dt: number; now: number }) => void | Promise<void>): () => void;
  /** Current time from the room clock (ms since epoch; fake in tests). */
  now(): number;
  readonly storage: RoomStorage;
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
  onJoin?(ctx: { room: Room<S, X>; player: Player; now: number }): MaybePromise<void>;
  onLeave?(ctx: { room: Room<S, X>; player: Player; now: number }): MaybePromise<void>;
  on?: { [K in keyof C]?: (ctx: { room: Room<S, X>; sender: Player; msg: Infer<C[K]>; now: number }) => MaybePromise<void> };
  /** Max non-spectator players. Default unlimited. */
  maxPlayers?: number;
  /** How long a disconnected player keeps their seat. Default 30 000 ms. */
  reconnectMs?: number;
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
