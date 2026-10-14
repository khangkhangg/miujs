import type { WsSendable } from "./types.ts";

/** Anything that can receive messages; `MiuSocket` qualifies, as do raw sockets. */
export interface RoomSocket {
  id?: string;
  send(data: WsSendable): void;
  /** If present, the hub leaves all rooms automatically when the socket closes. */
  onClose?(fn: () => void): () => void;
}

export interface RoomMember<M = unknown> {
  id: string;
  meta: M;
}

export interface RoomHubOptions<M = unknown> {
  onJoin?(room: string, member: RoomMember<M>): void;
  onLeave?(room: string, member: RoomMember<M>): void;
  /** Called after the last member leaves; the room is already removed. */
  onEmpty?(room: string): void;
}

export interface BroadcastOptions {
  /** Sockets (or socket ids) to skip. */
  except?: RoomSocket | string | (RoomSocket | string)[];
}

export interface RoomHub<M = unknown> {
  join(room: string, socket: RoomSocket, meta?: M): void;
  leave(room: string, socket: RoomSocket): void;
  /** Leave every room the socket is in. */
  leaveAll(socket: RoomSocket): void;
  /** Send to every member; objects are JSON-encoded. Returns the number delivered. */
  broadcast(room: string, message: unknown, opts?: BroadcastOptions): number;
  /** Presence list in join order. */
  members(room: string): RoomMember<M>[];
  sockets(room: string): RoomSocket[];
  has(room: string, socket: RoomSocket): boolean;
  size(room: string): number;
  rooms(): string[];
}

interface Entry<M> {
  member: RoomMember<M>;
}

interface Tracked {
  id: string;
  rooms: Set<string>;
  off?: () => void;
}

/**
 * In-process rooms with presence. Works for a single Bun/Node process or one
 * Durable Object; use `MiuRoom` for rooms shared across Workers isolates.
 */
export function createRoomHub<M = unknown>(opts: RoomHubOptions<M> = {}): RoomHub<M> {
  const rooms = new Map<string, Map<RoomSocket, Entry<M>>>();
  const tracked = new Map<RoomSocket, Tracked>();

  const track = (socket: RoomSocket): Tracked => {
    let t = tracked.get(socket);
    if (!t) {
      t = { id: socket.id ?? crypto.randomUUID(), rooms: new Set() };
      tracked.set(socket, t);
      t.off = socket.onClose?.(() => hub.leaveAll(socket));
    }
    return t;
  };

  const encode = (message: unknown): WsSendable =>
    typeof message === "string" || message instanceof ArrayBuffer || ArrayBuffer.isView(message)
      ? (message as WsSendable)
      : JSON.stringify(message);

  const hub: RoomHub<M> = {
    join(room, socket, meta) {
      const t = track(socket);
      let members = rooms.get(room);
      if (!members) rooms.set(room, (members = new Map()));
      const existing = members.get(socket);
      if (existing) {
        existing.member.meta = meta as M;
        return;
      }
      const member = { id: t.id, meta: meta as M };
      members.set(socket, { member });
      t.rooms.add(room);
      opts.onJoin?.(room, member);
    },
    leave(room, socket) {
      const members = rooms.get(room);
      const entry = members?.get(socket);
      if (!members || !entry) return;
      members.delete(socket);
      const t = tracked.get(socket);
      if (t) {
        t.rooms.delete(room);
        if (!t.rooms.size) {
          t.off?.();
          tracked.delete(socket);
        }
      }
      opts.onLeave?.(room, entry.member);
      if (!members.size) {
        rooms.delete(room);
        opts.onEmpty?.(room);
      }
    },
    leaveAll(socket) {
      const t = tracked.get(socket);
      if (t) for (const room of [...t.rooms]) hub.leave(room, socket);
    },
    broadcast(room, message, o = {}) {
      const members = rooms.get(room);
      if (!members) return 0;
      const except = o.except === undefined ? [] : Array.isArray(o.except) ? o.except : [o.except];
      const data = encode(message);
      let sent = 0;
      for (const [socket, { member }] of members) {
        if (except.some((x) => x === socket || x === member.id)) continue;
        try {
          socket.send(data);
          sent++;
        } catch {
          // closing socket; it will leave on close
        }
      }
      return sent;
    },
    members: (room) => [...(rooms.get(room)?.values() ?? [])].map((e) => e.member),
    sockets: (room) => [...(rooms.get(room)?.keys() ?? [])],
    has: (room, socket) => rooms.get(room)?.has(socket) ?? false,
    size: (room) => rooms.get(room)?.size ?? 0,
    rooms: () => [...rooms.keys()],
  };
  return hub;
}
