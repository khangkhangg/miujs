// Operator view of realtime rooms (rendered by @miujs/admin): live rooms, sockets and reconnect
// grace, a pageable rooms list, and broadcast / kick / close. In-process rooms are read from the
// registry; on Cloudflare each room is its own Durable Object, which a Worker cannot enumerate,
// so status and the list only see this isolate, while the actions are forwarded to the object.

import { errors, t, type Context, type ManageAction, type ManageSection, type ManageStat, type ManageValue } from "miujs";
import type { Clock } from "./clock.ts";
import type { LocalRooms } from "./registry.ts";
import type { RoomInstance } from "./room.ts";
import { parseShardId } from "./shard.ts";

/** What the plugin hands to `roomsManage`. */
export interface RoomsManageDeps {
  registry: LocalRooms;
  known: string[];
  clock: Clock;
  /** The Durable Object namespace for this request, or null when rooms are in-process. */
  namespace(ctx: Context): { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } } | null;
}

/** An operator operation on one room (also run inside the Durable Object). */
export type RoomOp = { op: "broadcast"; event: string; message?: string } | { op: "kick"; member: string } | { op: "close"; reason?: string };

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Status stops counting after this many rooms, so opening the page stays cheap. */
const SCAN_CAP = 10_000;
const STATE_PREVIEW = 200;
const MAX_PAGE = 100;

/**
 * Apply an operator operation to a room. Returns the message shown to the operator; throws
 * MIU_E_ROOM_NOT_FOUND when there is nothing to broadcast to or kick from. Closing a room that
 * is not open is a no-op, so retries are safe.
 */
export function applyRoomOp(inst: RoomInstance | null | undefined, label: string, op: RoomOp): string {
  const open = inst && !inst.isClosed ? inst : null;
  if (op.op === "close") {
    if (!open) return `Room ${label} is not open; nothing to close.`;
    open.close(op.reason || "closed by an operator");
    return `Closed room ${label}.`;
  }
  if (!open) throw roomNotFound(label);
  if (op.op === "kick") {
    if (!open.room.kick(op.member, 4009, "kicked by an operator")) return `Member "${op.member}" is not in room ${label} (already gone?).`;
    return `Kicked member "${op.member}" from room ${label}.`;
  }
  const connected = open.info().connected;
  open.room.broadcast(op.event, op.message ?? null);
  return `Sent "${op.event}" to ${connected} connected member${connected === 1 ? "" : "s"} of room ${label}.`;
}

export function roomNotFound(label: string) {
  return errors.custom({ code: "MIU_E_ROOM_NOT_FOUND", status: 404, message: `No active room ${label}`, fix: "Check the room type and id in the rooms list; the room may have closed." });
}

function preview(state: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(state) ?? "";
  } catch {
    s = "(not serializable)";
  }
  return s.length > STATE_PREVIEW ? `${s.slice(0, STATE_PREVIEW)}…` : s;
}

export function roomsManage(d: RoomsManageDeps): ManageSection[] {
  const typeSchema = t.enum(d.known as [string, ...string[]]);
  const idSchema = t.string({ minLength: 1, maxLength: 80, pattern: /^[A-Za-z0-9_:-]+$/ });
  const broadcastFields = {
    event: t.string({ minLength: 1, maxLength: 64, pattern: /^[A-Za-z0-9_.:-]+$/, description: "Event name the clients listen for" }),
    message: t.optional(t.string({ maxLength: 2_000, description: "Text sent as the event data" })),
  };
  const kickFields = { member: t.string({ minLength: 1, maxLength: 64, description: "Member (player) id" }) };
  const closeFields = { reason: t.optional(t.string({ maxLength: 200, description: "Shown to clients as the close reason" })) };

  function check(type: string, id: string): void {
    if (!d.known.includes(type)) {
      throw errors.custom({ code: "MIU_E_ROOM_TYPE_UNKNOWN", status: 404, message: `No room type "${type}"`, fix: `Use one of: ${d.known.join(", ")}.` });
    }
    const sh = parseShardId(id);
    if (!ROOM_ID.test(sh ? sh.id : id)) {
      throw errors.custom({ code: "MIU_E_ROOM_ID_INVALID", status: 400, message: "Room id must be 1-64 letters, digits, '_' or '-' (shards: id:shardN)", fix: "Copy the room id from the rooms list." });
    }
  }

  async function operate(ctx: Context, type: string, id: string, op: RoomOp): Promise<string> {
    check(type, id);
    const label = `${type}:${id}`;
    const ns = d.namespace(ctx);
    if (!ns) return applyRoomOp(d.registry.get(type, id), label, op);
    const url = `https://miu-room/_miu/admin?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
    const res = await ns.get(ns.idFromName(label)).fetch(new Request(url, { method: "POST", body: JSON.stringify(op) }));
    if (res.status === 404) throw roomNotFound(label);
    if (!res.ok) {
      throw errors.custom({ code: "MIU_E_ROOM_ADMIN_FAILED", status: 502, message: `The Durable Object for ${label} answered ${res.status}`, fix: "Pass the same rooms to createRoomDurableObject() and rooms({ rooms })." });
    }
    return String(((await res.json()) as { message?: string }).message ?? "Done.");
  }

  /** `type:id` from a list row id (the id itself may contain ":shardN"). */
  function split(rowId: unknown): { type: string; id: string } {
    const s = String(rowId ?? "");
    const i = s.indexOf(":");
    return i < 0 ? { type: s, id: "" } : { type: s.slice(0, i), id: s.slice(i + 1) };
  }

  const row = (fn: (r: { type: string; id: string }, input: any, ctx: Context) => Promise<string>) => (input: any, ctx: Context) => fn(split(input?.id), input, ctx);

  const rowActions: ManageAction[] = [
    {
      name: "broadcast",
      title: "Broadcast a message",
      description: "Send an event to every connected member of this room.",
      input: t.object(broadcastFields),
      run: row((r, i, ctx) => operate(ctx, r.type, r.id, { op: "broadcast", event: i.event, message: i.message })),
    },
    {
      name: "kick",
      title: "Kick a member",
      description: "Remove a member for good: their socket closes and their resume token stops working.",
      input: t.object(kickFields),
      danger: true,
      run: row((r, i, ctx) => operate(ctx, r.type, r.id, { op: "kick", member: i.member })),
    },
    {
      name: "close",
      title: "Close room",
      description: "Disconnect everyone and discard the room's state.",
      input: t.object(closeFields),
      danger: true,
      run: row((r, i, ctx) => operate(ctx, r.type, r.id, { op: "close", reason: i?.reason })),
    },
  ];

  const where = { type: typeSchema, id: idSchema };
  const actions: ManageAction[] = [
    {
      name: "broadcastRoom",
      title: "Broadcast to a room",
      description: "Send an event to every connected member of a room, by type and id (works on Cloudflare too).",
      input: t.object({ ...where, ...broadcastFields }),
      run: (i, ctx) => operate(ctx, i.type, i.id, { op: "broadcast", event: i.event, message: i.message }),
    },
    {
      name: "kickMember",
      title: "Kick a member from a room",
      description: "Remove a member from a room, by type and id (works on Cloudflare too).",
      input: t.object({ ...where, ...kickFields }),
      danger: true,
      run: (i, ctx) => operate(ctx, i.type, i.id, { op: "kick", member: i.member }),
    },
    {
      name: "closeRoom",
      title: "Close a room",
      description: "Disconnect everyone and discard a room's state, by type and id (works on Cloudflare too).",
      input: t.object({ ...where, ...closeFields }),
      danger: true,
      run: (i, ctx) => operate(ctx, i.type, i.id, { op: "close", reason: i.reason }),
    },
  ];

  return [
    {
      id: "rooms",
      title: "Realtime rooms",
      description: "Live rooms, connected sockets and members waiting to reconnect.",
      status(ctx) {
        const onDo = d.namespace(ctx) !== null;
        const byType = new Map<string, { type: string; rooms: number; members: number; connected: number }>();
        for (const type of d.known) byType.set(type, { type, rooms: 0, members: 0, connected: 0 });
        let rooms = 0;
        let sockets = 0;
        let grace = 0;
        let graceRooms = 0;
        let capped = false;
        for (const inst of d.registry.instances()) {
          if (rooms >= SCAN_CAP) {
            capped = true;
            break;
          }
          rooms++;
          sockets += inst.connections;
          const g = inst.inGrace;
          grace += g;
          if (g > 0) graceRooms++;
          const info = inst.info();
          const row = byType.get(inst.type);
          if (row) {
            row.rooms++;
            row.members += info.players;
            row.connected += info.connected;
          }
        }
        const scope = onDo
          ? "On Cloudflare every room is its own Durable Object and a Worker cannot list them, so this counts only rooms held in this isolate (normally 0). Use the room actions with a type and id."
          : "Rooms in this process; other server instances are not included.";
        const more = capped ? ` Counted the first ${SCAN_CAP} rooms only.` : "";
        const stats: ManageStat[] = [
          { label: "Live rooms", value: rooms, hint: scope + more },
          { label: "Connected sockets", value: sockets, hint: "Open WebSockets, joined or not." },
          { label: "Members in reconnect grace", value: grace, hint: "Dropped connections whose seat is held until they resume or the grace period ends.", tone: grace > 0 ? "warning" : undefined },
          { label: "Rooms in reconnect grace", value: graceRooms },
        ];
        return {
          stats,
          tables: [
            {
              title: "Rooms by type",
              columns: [
                { key: "type", label: "Type" },
                { key: "rooms", label: "Rooms", type: "number" },
                { key: "members", label: "Members", type: "number" },
                { key: "connected", label: "Connected", type: "number" },
              ],
              rows: [...byType.values()],
            },
          ],
        };
      },
      lists: [
        {
          name: "rooms",
          title: "Rooms",
          idKey: "room",
          searchable: true,
          filters: [{ key: "type", label: "Type", options: [...d.known] }],
          columns: [
            { key: "room", label: "Room", type: "code" },
            { key: "type", label: "Type" },
            { key: "id", label: "Id", type: "code" },
            { key: "members", label: "Members", type: "number" },
            { key: "connected", label: "Connected", type: "number" },
            { key: "grace", label: "In grace", type: "number" },
            { key: "age", label: "Age", type: "duration" },
            { key: "state", label: "State", type: "code" },
          ],
          list(q, ctx) {
            if (d.namespace(ctx)) return { rows: [] };
            const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(q.limit) || MAX_PAGE));
            const start = /^\d+$/.test(q.cursor ?? "") ? Number(q.cursor) : 0;
            const type = q.filters?.type;
            const search = q.search?.trim().toLowerCase();
            const now = d.clock.now();
            const rows: Record<string, ManageValue>[] = [];
            let index = 0;
            let next: string | undefined;
            for (const inst of d.registry.instances()) {
              if (type && inst.type !== type) continue;
              if (search && !inst.id.toLowerCase().includes(search)) continue;
              if (index++ < start) continue;
              if (rows.length === limit) {
                next = String(start + limit);
                break;
              }
              const info = inst.info();
              rows.push({
                room: `${inst.type}:${inst.id}`,
                type: inst.type,
                id: inst.id,
                members: info.players,
                connected: info.connected,
                grace: inst.inGrace,
                age: Math.max(0, now - inst.createdAt),
                state: preview(inst.room.state),
              });
            }
            return next === undefined ? { rows } : { rows, next };
          },
          rowActions,
        },
      ],
      actions,
    },
  ];
}
