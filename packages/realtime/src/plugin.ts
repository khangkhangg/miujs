import { definePlugin, errors, processEnv, route, type CloudflareNeeds, type Context, type McpTool } from "miujs";
import { CLIENT_JS, CLIENT_JS_HASH } from "./client-bundle.ts";
import { systemClock, type Clock } from "./clock.ts";
import { CODE_RE, KvCodeStore, MemoryCodeStore, allocateCode, createCode, type CodeStore, type CodeTarget, type KvLike } from "./codes.ts";
import type { RoomType } from "./define.ts";
import { KeyedLimiter } from "./limiter.ts";
import { LocalRooms } from "./registry.ts";
import { shardConfig, shardFromToken, shardId, type ShardConfig } from "./shard.ts";
import { cleanParams, type JoinParams, type RoomInstance } from "./room.ts";

export interface RoomsOptions {
  rooms: readonly RoomType<any, any, any>[];
  /** Route prefix. Default `/rooms` → `GET /rooms/:type/:id`. */
  path?: string;
  /** Durable Object namespace binding used on Cloudflare. Default `MIU_ROOMS`. */
  binding?: string;
  /** Exported Durable Object class name (for `miu deploy cloudflare`). Default `MiuRooms`. */
  className?: string;
  /**
   * KV namespace binding for join codes on Cloudflare (declared by `cloudflare()`). Without it,
   * codes live in memory: fine locally, but per-isolate on Workers.
   */
  codes?: string;
  /** How long a join code stays valid. Default 6 hours. */
  codeTtlMs?: number;
  /** Per-IP limit on `GET /rooms/code/:code` (against guessing). Default 30/min, burst 10. */
  codeLookups?: { perMinute?: number; burst?: number };
  /** Dispose local rooms after they stay empty this long. Default 30 000 ms. */
  emptyMs?: number;
  clock?: Clock;
}

export interface CreateRoomOptions {
  /** Passed to the room's `init` / `secret` as `ctx.data`. */
  data?: unknown;
  /**
   * Workers bindings (`ctx.env`). Defaults to the env of the request being handled, so inside
   * a route handler you can leave it out.
   */
  env?: Record<string, unknown>;
  /** `false`: no 6-digit join code (rooms reached by id only, e.g. matchmaker rooms). Default true. */
  code?: boolean;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** Reads `name`, `role`, `resume`, `hostKey`, `enc` from a query string object. */
export function joinParamsFrom(query: Record<string, unknown>): JoinParams {
  return { name: first(query.name), role: first(query.role), resume: first(query.resume), hostKey: first(query.hostKey), enc: first(query.enc), params: cleanParams(query) };
}

function nsFrom(env: Record<string, unknown> | undefined, binding: string): DurableObjectNamespaceLike | null {
  const ns = env?.[binding] as DurableObjectNamespaceLike | undefined;
  return ns && typeof ns.idFromName === "function" ? ns : null;
}

function namespace(ctx: Context, binding: string): DurableObjectNamespaceLike | null {
  if (ctx.runtime !== "workerd") return null;
  return nsFrom(ctx.env, binding);
}

function unknownType(type: string, known: string[]) {
  return errors.custom({ code: "MIU_E_ROOM_TYPE_UNKNOWN", status: 404, message: `No room type "${type}"`, fix: `Use one of: ${known.join(", ")}, or add the room to rooms({ rooms: [...] }).` });
}

function checkRoute(registry: LocalRooms, type: string, id: string, known: string[]): void {
  if (!registry.has(type)) throw unknownType(type, known);
  if (!ROOM_ID_RE.test(id)) {
    throw errors.custom({ code: "MIU_E_ROOM_ID_INVALID", status: 400, message: "Room id must be 1-64 letters, digits, '_' or '-'", fix: "Use the id from createRoom(), or a short code such as one from rooms.createCode()." });
  }
}

function randomRoomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "r";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function roomsPlugin(opts: RoomsOptions) {
  const prefix = (opts.path ?? "/rooms").replace(/\/+$/, "");
  const binding = opts.binding ?? "MIU_ROOMS";
  const className = opts.className ?? "MiuRooms";
  const clock = opts.clock ?? systemClock;
  /** Workers env of the latest request (the same object for every request in an isolate). */
  let workerEnv: Record<string, unknown> | undefined;
  let localEnv: Record<string, unknown> | undefined;
  // room.env for in-process rooms: the request env on Workers (no DO binding), else the process env.
  const registry = new LocalRooms(opts.rooms, { clock, emptyMs: opts.emptyMs, env: () => workerEnv ?? (localEnv ??= processEnv()) });
  const known = opts.rooms.map((r) => r.type);
  const defs = new Map(opts.rooms.map((r) => [r.type, r] as const));
  const codeTtlMs = opts.codeTtlMs ?? 6 * 3_600_000;
  const memoryCodes = new MemoryCodeStore(clock);
  const perMinute = opts.codeLookups?.perMinute ?? 30;
  const lookups = new KeyedLimiter({ perSecond: perMinute / 60, burst: opts.codeLookups?.burst ?? 10 });
  let warned = false;

  const codeStore = (env: Record<string, unknown> | undefined): CodeStore => {
    const kv = opts.codes ? (env?.[opts.codes] as KvLike | undefined) : undefined;
    return kv && typeof kv.put === "function" ? new KvCodeStore(kv) : memoryCodes;
  };

  /** Create a room with init data and a 6-digit join code (`code: false` skips the code). */
  function createRoom(type: string, o: CreateRoomOptions & { code: false }): Promise<{ id: string }>;
  function createRoom(type: string, o?: CreateRoomOptions): Promise<{ id: string; code: string }>;
  async function createRoom(type: string, o: CreateRoomOptions = {}): Promise<{ id: string; code?: string }> {
    if (!registry.has(type)) throw unknownType(type, known);
    const env = o.env ?? workerEnv;
    const id = randomRoomId();
    const code = o.code === false ? undefined : await allocateCode(codeStore(env), { type, id }, codeTtlMs);
    const ns = nsFrom(env, binding);
    if (ns) {
      const url = `https://miu-room/_miu/create?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
      const res = await ns.get(ns.idFromName(`${type}:${id}`)).fetch(new Request(url, { method: "POST", body: JSON.stringify({ data: o.data ?? null }) }));
      if (!res.ok) {
        throw errors.custom({ code: "MIU_E_ROOM_CREATE_FAILED", status: 502, message: `The Durable Object for ${type}:${id} answered ${res.status}`, fix: "Pass the same rooms to createRoomDurableObject() and rooms({ rooms })." });
      }
    } else {
      registry.create(type, id, o.data);
    }
    return code === undefined ? { id } : { id, code };
  }

  const resolveCode = route.get(`${prefix}/code/:code`, {
    name: "miu_rooms_code",
    summary: "Resolve a 6-digit join code to a room type and id",
    mcp: false,
    handler: async (ctx): Promise<CodeTarget> => {
      const ip = (ctx as unknown as { ip?: string }).ip ?? "unknown";
      if (!lookups.take(ip, clock.now())) {
        throw errors.custom({ code: "MIU_E_ROOM_CODE_RATE_LIMITED", status: 429, message: "Too many join-code lookups", fix: `Wait a few seconds; at most ${perMinute} lookups per minute are allowed per IP.` });
      }
      const code = ctx.params.code;
      const found = CODE_RE.test(code) ? await codeStore(ctx.runtime === "workerd" ? ctx.env : undefined).get(code) : null;
      if (!found) {
        throw errors.custom({ code: "MIU_E_ROOM_CODE_UNKNOWN", status: 404, message: `No room with code ${JSON.stringify(code)}`, fix: "Check the 6-digit code; codes expire a few hours after the room was created." });
      }
      return found;
    },
  });

  const connect = route.get(`${prefix}/:type/:id`, {
    name: "miu_rooms_connect",
    summary: "Join a realtime room over WebSocket (see PROTOCOL.md)",
    mcp: false,
    handler: (ctx) => {
      const { type, id } = ctx.params;
      checkRoute(registry, type, id, known);
      const ns = namespace(ctx as unknown as Context, binding);
      if (ns) {
        const cfg = shardConfig(defs.get(type)!);
        return cfg ? joinShard(ns, type, id, cfg, joinParamsFrom(ctx.query), ctx.req) : ns.get(ns.idFromName(`${type}:${id}`)).fetch(ctx.req);
      }
      if (ctx.runtime === "workerd" && !warned) {
        warned = true;
        ctx.log.warn(`rooms: no Durable Object binding "${binding}"; using in-isolate rooms (not shared across isolates)`);
      }
      const join = joinParamsFrom(ctx.query);
      let inst: RoomInstance | null = null;
      return ctx.upgrade({
        open(socket) {
          inst = registry.route(type, id, join);
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

  // The browser client (src/client.ts, bundled): a stable URL that revalidates, and a hashed one
  // that never changes, for <script type="module" src="..."> / import() without a build step.
  const clientPath = `${prefix}/_client/${CLIENT_JS_HASH}.js`;
  const etag = `"${CLIENT_JS_HASH}"`;
  const js = (cacheControl: string) =>
    new Response(CLIENT_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": cacheControl, etag, "x-content-type-options": "nosniff" } });
  const clientStable = route.get(`${prefix}/_client.js`, {
    name: "miu_rooms_client",
    summary: "The rooms browser client as an ES module",
    mcp: false,
    internal: true,
    handler: (ctx) => {
      const inm = ctx.headers.get("if-none-match");
      if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
      return js("no-cache");
    },
  });
  const clientHashed = route.get(`${prefix}/_client/:file`, {
    name: "miu_rooms_client_hashed",
    summary: "The rooms browser client at its content-hashed URL",
    mcp: false,
    internal: true,
    handler: (ctx) => {
      if (ctx.params.file !== `${CLIENT_JS_HASH}.js`) {
        throw errors.custom({ code: "MIU_E_ROOM_CLIENT_NOT_FOUND", status: 404, message: "No such client build", fix: `Load ${clientPath} (rooms plugin .clientPath) or ${prefix}/_client.js.` });
      }
      return js("public, max-age=31536000, immutable");
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
    routes: [connect, resolveCode, clientStable, clientHashed],
    /** URL path of the browser client module (content-hashed, cached forever). */
    clientPath,
    /** The in-process registry (Bun/Deno/Node). */
    registry,
    createRoom,
    /** Route prefix, e.g. `/rooms` (rooms live at `${path}/:type/:id`). */
    path: prefix,
    onRequest(ctx: Context) {
      if (ctx.runtime === "workerd") workerEnv = ctx.env;
    },
    mcpTools: () => tools,
    cloudflare: (): CloudflareNeeds & { durableObjects: { binding: string; className: string }[] } =>
      opts.codes ? { durableObjects: [{ binding, className }], kv: [opts.codes] } : { durableObjects: [{ binding, className }] },
    inspect: () => ({ path: `${prefix}/:type/:id`, types: known, rooms: registry.list() }),
  });
}

/**
 * Cloudflare, sharded type: a resume token names its shard; otherwise the coordinator object
 * `type:id` assigns one. The join is then forwarded to the shard object `type:id:shardN`.
 */
async function joinShard(ns: DurableObjectNamespaceLike, type: string, id: string, cfg: ShardConfig, join: JoinParams, req: Request): Promise<Response> {
  let n = shardFromToken(join.resume, cfg.maxShards);
  if (n === null) {
    const u = `https://miu-room/_miu/shard/assign?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
    const res = await ns.get(ns.idFromName(`${type}:${id}`)).fetch(new Request(u, { method: "POST", body: JSON.stringify({ role: join.role ?? "player" }) }));
    n = Number(((await res.json()) as { shard?: number }).shard ?? 0);
  }
  const headers = new Headers(req.headers);
  headers.set("x-miu-shard", String(n));
  return ns.get(ns.idFromName(`${type}:${shardId(id, n)}`)).fetch(new Request(req.url, { method: "GET", headers }));
}

function notFound(type: string, id: string) {
  return errors.custom({ code: "MIU_E_ROOM_NOT_FOUND", status: 404, message: `No active room ${type}/${id}`, fix: "Call rooms_list to see active rooms." });
}

/**
 * Realtime rooms battery.
 *
 * ```ts
 * const realtime = rooms({ rooms: [quiz] }); // GET /rooms/:type/:id (WebSocket), GET /rooms/code/:code
 * const { id, code } = await realtime.createRoom("quiz", { data: { questions } });
 * miu({ plugins: [realtime] });
 * ```
 */
export const rooms = Object.assign(roomsPlugin, { createCode });
