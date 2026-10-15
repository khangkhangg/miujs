// In-process room registry for Bun / Deno / Node: rooms are created on first join and disposed
// after staying empty for `emptyMs`.

import type { MiuSocket } from "miujs";
import { systemClock, type Clock } from "./clock.ts";
import type { RoomType } from "./define.ts";
import { RoomInstance, type RoomHooks, type RoomInfo } from "./room.ts";

export interface LocalRoomsOptions {
  clock?: Clock;
  /** How long an empty room lives before it is disposed. Default 30 000 ms. */
  emptyMs?: number;
  onError?: RoomHooks["onError"];
}

export class LocalRooms {
  private types = new Map<string, RoomType>();
  private rooms = new Map<string, RoomInstance>();
  private disposing = new Map<RoomInstance, unknown>();
  private clock: Clock;
  private emptyMs: number;
  private onError?: RoomHooks["onError"];

  constructor(roomTypes: readonly RoomType<any, any, any>[], opts: LocalRoomsOptions = {}) {
    for (const r of roomTypes) this.types.set(r.type, r);
    this.clock = opts.clock ?? systemClock;
    this.emptyMs = opts.emptyMs ?? 30_000;
    this.onError = opts.onError;
  }

  has(type: string): boolean {
    return this.types.has(type);
  }

  get(type: string, id: string): RoomInstance | undefined {
    return this.rooms.get(`${type}:${id}`);
  }

  /** The room `type:id`, created if needed. `null` when the type is unknown. */
  open(type: string, id: string, data?: unknown): RoomInstance | null {
    const key = `${type}:${id}`;
    const existing = this.rooms.get(key);
    if (existing && !existing.isClosed) return existing;
    const def = this.types.get(type);
    if (!def) return null;
    const inst: RoomInstance = new RoomInstance(def, {
      id,
      clock: this.clock,
      data,
      hooks: {
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

  private scheduleDispose(room: RoomInstance): void {
    if (this.disposing.has(room) || room.isClosed) return;
    const h = this.clock.setTimeout(() => {
      this.disposing.delete(room);
      if (room.isEmpty && room.connections === 0) room.close("room empty");
    }, this.emptyMs);
    this.disposing.set(room, h);
  }
}
