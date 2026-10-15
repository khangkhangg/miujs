import { definePlugin, errors, route, type CloudflareNeeds, type Context, type McpTool } from "miujs";
import type { Clock } from "./clock.ts";
import type { RoomType } from "./define.ts";
import { LocalRooms } from "./registry.ts";
import type { JoinParams, RoomInstance } from "./room.ts";

export interface RoomsOptions {
  rooms: readonly RoomType<any, any, any>[];
  /** Route prefix. Default `/rooms` → `GET /rooms/:type/:id`. */
  path?: string;
  /** Durable Object namespace binding used on Cloudflare. Default `MIU_ROOMS`. */
  binding?: string;
  /** Exported Durable Object class name (for `miu deploy cloudflare`). Default `MiuRooms`. */
  className?: string;
  /** Dispose local rooms after they stay empty this long. Default 30 000 ms. */
  emptyMs?: number;
  clock?: Clock;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** Reads `name`, `role`, `resume`, `hostKey` from a query string object. */
export function joinParamsFrom(query: Record<string, unknown>): JoinParams {
  return { name: first(query.name), role: first(query.role), resume: first(query.resume), hostKey: first(query.hostKey) };
}

function namespace(ctx: Context, binding: string): DurableObjectNamespaceLike | null {
  if (ctx.runtime !== "workerd") return null;
  const ns = ctx.env?.[binding] as DurableObjectNamespaceLike | undefined;
  return ns && typeof ns.idFromName === "function" ? ns : null;
}

function checkRoute(registry: LocalRooms, type: string, id: string, known: string[]): void {
  if (!registry.has(type)) {
    throw errors.custom({ code: "MIU_E_ROOM_TYPE_UNKNOWN", status: 404, message: `No room type "${type}"`, fix: `Use one of: ${known.join(", ")}, or add the room to rooms({ rooms: [...] }).` });
  }
  if (!ROOM_ID_RE.test(id)) {
    throw errors.custom({ code: "MIU_E_ROOM_ID_INVALID", status: 400, message: "Room id must be 1-64 letters, digits, '_' or '-'", fix: "Use a short code such as one from rooms.createCode()." });
  }
}

function roomsPlugin(opts: RoomsOptions) {
  const prefix = (opts.path ?? "/rooms").replace(/\/+$/, "");
  const binding = opts.binding ?? "MIU_ROOMS";
  const className = opts.className ?? "MiuRooms";
  const registry = new LocalRooms(opts.rooms, { clock: opts.clock, emptyMs: opts.emptyMs });
  const known = opts.rooms.map((r) => r.type);
  let warned = false;

  const connect = route.get(`${prefix}/:type/:id`, {
    name: "miu_rooms_connect",
    summary: "Join a realtime room over WebSocket (see PROTOCOL.md)",
    mcp: false,
    handler: (ctx) => {
      const { type, id } = ctx.params;
      checkRoute(registry, type, id, known);
      const ns = namespace(ctx as unknown as Context, binding);
      if (ns) return ns.get(ns.idFromName(`${type}:${id}`)).fetch(ctx.req);
      if (ctx.runtime === "workerd" && !warned) {
        warned = true;
        ctx.log.warn(`rooms: no Durable Object binding "${binding}"; using in-isolate rooms (not shared across isolates)`);
      }
      const join = joinParamsFrom(ctx.query);
      let inst: RoomInstance | null = null;
      return ctx.upgrade({
        open(socket) {
          inst = registry.open(type, id);
          inst!.connect(socket, join);
        },
        message(socket, m) {
          return inst?.receive(socket, m) ?? undefined;
        },
        close(socket) {
          if (inst) registry.disconnected(inst, socket);
        },
      });
    },
  });

  const tools: McpTool[] = [
    {
      name: "rooms_list",
      description: "List active realtime rooms with player counts.",
      inputSchema: { type: "object", properties: {} },
      call: (_args, ctx) => {
        if (namespace(ctx, binding)) {
          return { rooms: [], note: "On Cloudflare each room is a Durable Object; use room_state with a known type and id." };
        }
        return { rooms: registry.list() };
      },
    },
    {
      name: "room_state",
      description: "Show a realtime room's current state and players (secret state is never shown).",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string", enum: known }, id: { type: "string" } },
        required: ["type", "id"],
      },
      call: async (args, ctx) => {
        const type = String(args.type ?? "");
        const id = String(args.id ?? "");
        checkRoute(registry, type, id, known);
        const ns = namespace(ctx, binding);
        if (ns) {
          const res = await ns.get(ns.idFromName(`${type}:${id}`)).fetch(new Request(`https://miu-room/_miu/room?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`));
          if (res.status === 404) throw notFound(type, id);
          return res.json();
        }
        const inst = registry.get(type, id);
        if (!inst || inst.isClosed) throw notFound(type, id);
        return inst.describe();
      },
    },
  ];

  return definePlugin({
    name: "rooms",
    routes: [connect],
    /** The in-process registry (Bun/Deno/Node). */
    registry,
    mcpTools: () => tools,
    cloudflare: (): CloudflareNeeds & { durableObjects: { binding: string; className: string }[] } => ({ durableObjects: [{ binding, className }] }),
    inspect: () => ({ path: `${prefix}/:type/:id`, types: known, rooms: registry.list() }),
  });
}

function notFound(type: string, id: string) {
  return errors.custom({ code: "MIU_E_ROOM_NOT_FOUND", status: 404, message: `No active room ${type}/${id}`, fix: "Call rooms_list to see active rooms." });
}

const CODE_MIN = 100_000;

/** A random 6-digit join code (100000-999999). */
function createCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(CODE_MIN + (b[0] % 900_000));
}

/**
 * Realtime rooms battery.
 *
 * ```ts
 * miu({ plugins: [rooms({ rooms: [quiz] })] }) // → GET /rooms/:type/:id (WebSocket)
 * ```
 */
export const rooms = Object.assign(roomsPlugin, { createCode });
