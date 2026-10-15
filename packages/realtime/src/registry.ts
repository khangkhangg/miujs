// In-process room registry for Bun / Deno / Node: rooms are created on first join and disposed
// after staying empty for `emptyMs`. Sharded room types are routed across shard rooms here, and
// the registry acts as their coordinator (aggregate + publish).

import type { MiuSocket } from "miujs";
import { systemClock, type Clock } from "./clock.ts";
import type { RoomType } from "./define.ts";
import { jsonEqual } from "./diff.ts";
import { RoomInstance, type JoinParams, type RoomHooks, type RoomInfo } from "./room.ts";
import { pickShard, shardConfig, shardFromToken, shardId, shardTokenPrefix, type ShardConfig } from "./shard.ts";

export interface LocalRoomsOptions {
  clock?: Clock;
  /** How long an empty room lives before it is disposed. Default 30 000 ms. */
  emptyMs?: number;
  onError?: RoomHooks["onError"];
  /** `room.env` for rooms made here (called per room). Default: {}. */
  env?: () => Record<string, unknown>;
}

export class LocalRooms {
  private types = new Map<string, RoomType>();
  private rooms = new Map<string, RoomInstance>();
  private disposing = new Map<RoomInstance, unknown>();
  private clock: Clock;
  private emptyMs: number;
  private onError?: RoomHooks["onError"];
  private env?: () => Record<string, unknown>;
  /** Sharded rooms, by `type:id`: creation data and the last published aggregate. */
  private sharded = new Map<string, { data?: unknown; aggregate?: unknown; publishing: boolean }>();

  constructor(roomTypes: readonly RoomType<any, any, any>[], opts: LocalRoomsOptions = {}) {
    for (const r of roomTypes) this.types.set(r.type, r);
    this.clock = opts.clock ?? systemClock;
    this.emptyMs = opts.emptyMs ?? 30_000;
    this.onError = opts.onError;
    this.env = opts.env;
  }

  has(type: string): boolean {
    return this.types.has(type);
  }

  get(type: string, id: string): RoomInstance | undefined {
    return this.rooms.get(`${type}:${id}`);
  }

  /** The room `type:id`, created if needed. `null` when the type is unknown. */
  open(type: string, id: string, data?: unknown, extra: { tokenPrefix?: string; onChange?: () => void } = {}): RoomInstance | null {
    const key = `${type}:${id}`;
    const existing = this.rooms.get(key);
    if (existing && !existing.isClosed) return existing;
    const def = this.types.get(type);
    if (!def) return null;
    const inst: RoomInstance = new RoomInstance(def, {
      id,
      clock: this.clock,
      data,
      tokenPrefix: extra.tokenPrefix,
      env: this.env?.() ?? {},
      hooks: {
        onChange: extra.onChange,
        onEmpty: () => this.scheduleDispose(inst),
        onClose: () => {
          if (this.rooms.get(key) === inst) this.rooms.delete(key);
          const h = this.disposing.get(inst);
          if (h) this.clock.clearTimeout(h);
          this.disposing.delete(inst);
        },
        onError: this.onError,
      },
    });
    this.rooms.set(key, inst);
    return inst;
  }

  /**
   * The room a new connection should join. For sharded types: the shard named by a resume
   * token, else the first shard with a free seat. `null` when the type is unknown.
   */
  route(type: string, id: string, join: JoinParams): RoomInstance | null {
    const def = this.types.get(type);
    if (!def) return null;
    const cfg = shardConfig(def);
    if (!cfg) return this.open(type, id);
    const n = shardFromToken(join.resume, cfg.maxShards) ?? pickShard((i) => this.get(type, shardId(id, i))?.seated ?? 0, cfg, join.role);
    return this.openShard(type, id, n, cfg);
  }

  /** Create `type:id` with init data ahead of the first join; disposed after `emptyMs` if nobody comes. */
  create(type: string, id: string, data?: unknown): RoomInstance | null {
    const def = this.types.get(type);
    if (def && shardConfig(def)) {
      this.shardEntry(type, id).data = data; // each shard is built with it on first join
      return null;
    }
    const inst = this.open(type, id, data);
    if (inst && inst.connections === 0 && inst.isEmpty) this.scheduleDispose(inst);
    return inst;
  }

  /** Live shard rooms of sharded room `type:id`, by shard number. */
  shards(type: string, id: string): { shard: number; room: RoomInstance }[] {
    const cfg = this.types.has(type) ? shardConfig(this.types.get(type)!) : null;
    if (!cfg) return [];
    const out: { shard: number; room: RoomInstance }[] = [];
    for (let n = 0; n < cfg.maxShards; n++) {
      const room = this.get(type, shardId(id, n));
      if (room && !room.isClosed) out.push({ shard: n, room });
    }
    return out;
  }

  /** The coordinator's aggregate for sharded room `type:id` (undefined without `aggregate`). */
  aggregate(type: string, id: string): unknown {
    const cfg = this.types.has(type) ? shardConfig(this.types.get(type)!) : null;
    if (!cfg?.aggregate) return undefined;
    return cfg.aggregate(this.shards(type, id).map(({ shard, room }) => ({ shard, state: room.describe().state, players: room.seated })));
  }

  /** Tell the registry a socket closed (so empty rooms can be disposed). */
  disconnected(room: RoomInstance, socket: MiuSocket): void {
    room.disconnect(socket);
    if (room.isEmpty) this.scheduleDispose(room);
  }

  list(): RoomInfo[] {
    return [...this.rooms.values()].map((r) => r.info());
  }

  /** Close every room (server shutdown). */
  closeAll(): void {
    for (const r of [...this.rooms.values()]) r.close("server shutting down");
  }

  private shardEntry(type: string, id: string) {
    const key = `${type}:${id}`;
    let e = this.sharded.get(key);
    if (!e) this.sharded.set(key, (e = { publishing: false }));
    return e;
  }

  private openShard(type: string, id: string, n: number, cfg: ShardConfig): RoomInstance | null {
    const existing = this.get(type, shardId(id, n));
    if (existing && !existing.isClosed) return existing;
    const entry = this.shardEntry(type, id);
    const inst = this.open(type, shardId(id, n), entry.data, { tokenPrefix: shardTokenPrefix(n), onChange: () => this.coordinate(type, id, cfg) });
    if (inst && cfg.publish && entry.aggregate !== undefined) {
      const agg = entry.aggregate;
      void inst.update((room) => cfg.publish!({ room, aggregate: agg }), "shards.publish");
    }
    return inst;
  }

  /** A shard changed: recompute the aggregate and publish it to every shard if it moved. */
  private coordinate(type: string, id: string, cfg: ShardConfig): void {
    const entry = this.shardEntry(type, id);
    if (!cfg.aggregate || entry.publishing) return;
    const agg = this.aggregate(type, id);
    if (entry.aggregate !== undefined && jsonEqual(agg, entry.aggregate)) return;
    entry.aggregate = agg;
    if (!cfg.publish) return;
    entry.publishing = true;
    try {
      for (const { room } of this.shards(type, id)) void room.update((r) => cfg.publish!({ room: r, aggregate: agg }), "shards.publish");
    } finally {
      entry.publishing = false;
    }
  }

  private scheduleDispose(room: RoomInstance): void {
    if (this.disposing.has(room) || room.isClosed) return;
    const h = this.clock.setTimeout(() => {
      this.disposing.delete(room);
      if (room.isEmpty && room.connections === 0) room.close("room empty");
    }, this.emptyMs);
    this.disposing.set(room, h);
  }
}
