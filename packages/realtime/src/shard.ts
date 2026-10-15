// Large rooms: one logical room split into shard rooms of at most `shardSize` players, plus a
// coordinator that routes joins and aggregates across shards (e.g. a global leaderboard).
//
//   export const arena = shardedRoom(battle, {
//     shardSize: 100,
//     aggregate: (shards) => topTen(shards.flatMap((s) => Object.values(s.state.scores))),
//     publish: ({ room, aggregate }) => { room.state.top = aggregate; },
//   });
//   rooms({ rooms: [arena] })   // GET /rooms/battle/finals → shard finals:shard0, finals:shard1, ...
//
// Locally the registry routes and aggregates in-process. On Cloudflare the Durable Object named
// "type:id" is the coordinator and each shard is its own object "type:id:shardN".

import { errors } from "miujs";
import type { Room, RoomType } from "./define.ts";

export interface ShardInfo<S = any> {
  shard: number;
  state: S;
  /** Seated (non-spectator) players in this shard. */
  players: number;
}

export interface ShardOptions<S, X, A> {
  /** Max players per shard (becomes each shard's `maxPlayers`). */
  shardSize: number;
  /** Upper bound on shards. Default 64. Joins beyond it get MIU_E_ROOM_FULL. */
  maxShards?: number;
  /** Combine every shard's state into one value. Runs after any shard changes. */
  aggregate?: (shards: ShardInfo<S>[]) => A;
  /** Push the aggregate into a shard's state (runs in each shard when the aggregate changes). */
  publish?: (ctx: { room: Room<S, X>; aggregate: A }) => void;
}

export interface ShardConfig<S = any, X = any, A = any> extends ShardOptions<S, X, A> {
  maxShards: number;
}

export interface ShardedRoomType<S = any, X = any, A = any> extends RoomType<S, X, any> {
  readonly shards: ShardConfig<S, X, A>;
}

/** Split a room type into shards of `shardSize` players with a coordinator. */
export function shardedRoom<S, X, A = unknown>(room: RoomType<S, X, any>, opts: ShardOptions<S, X, A>): ShardedRoomType<S, X, A> {
  if (!Number.isInteger(opts.shardSize) || opts.shardSize < 1) {
    throw errors.config("MIU_E_ROOM_SHARD_SIZE", `shardedRoom("${room.type}") needs a positive integer shardSize`, "Pass e.g. shardedRoom(room, { shardSize: 100 }).");
  }
  if (room.def.maxPlayers !== undefined && room.def.maxPlayers < opts.shardSize) {
    throw errors.config("MIU_E_ROOM_SHARD_SIZE", `Room "${room.type}" has maxPlayers ${room.def.maxPlayers}, smaller than shardSize ${opts.shardSize}`, "Remove maxPlayers from the room or lower shardSize.");
  }
  return {
    __miu: "room",
    type: room.type,
    def: { ...room.def, maxPlayers: opts.shardSize },
    shards: { maxShards: 64, ...opts },
  };
}

export function shardConfig(t: RoomType<any, any, any>): ShardConfig | null {
  return (t as Partial<ShardedRoomType>).shards ?? null;
}

/** Instance id of shard `n` of room `id` (the Durable Object is named `type:${shardId}`). */
export function shardId(id: string, n: number): string {
  return `${id}:shard${n}`;
}

/** `{ id, shard }` for a shard instance id, or null for a plain room id. */
export function parseShardId(instanceId: string): { id: string; shard: number } | null {
  const m = /^(.*):shard(\d+)$/.exec(instanceId);
  return m ? { id: m[1], shard: Number(m[2]) } : null;
}

/** Resume tokens of shard rooms start with `s<n>.` so a reconnect finds its shard without a lookup. */
export function shardTokenPrefix(n: number): string {
  return `s${n}.`;
}

export function shardFromToken(token: string | undefined, maxShards: number): number | null {
  const m = token ? /^s(\d+)\./.exec(token) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return n < maxShards ? n : null;
}

/** First shard with a free seat (spectators always watch shard 0). */
export function pickShard(seated: (n: number) => number, cfg: ShardConfig, role: string | undefined): number {
  if (role === "spectator") return 0;
  for (let n = 0; n < cfg.maxShards; n++) if (seated(n) < cfg.shardSize) return n;
  return cfg.maxShards - 1; // all full: let the last shard answer MIU_E_ROOM_FULL
}
