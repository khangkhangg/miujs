// Cloudflare transport: one Durable Object per room (named "type:id"). Uses the WebSocket
// hibernation API so idle rooms cost nothing; state, players, resume tokens, named timers and
// reconnect-grace deadlines are persisted to DO storage, and a DO alarm wakes the object for the
// earliest timer, so timers survive hibernation and eviction.
//
// Sharded room types (`shardedRoom`): the object "type:id" is the coordinator (routes joins,
// aggregates); each shard is its own object "type:id:shardN".
//
//   export const MiuRooms = createRoomDurableObject([quiz]);   // wrangler: binding MIU_ROOMS

import { errors, type MiuSocket } from "miujs";
import { systemClock, type Clock } from "./clock.ts";
import type { RoomStorage, RoomType } from "./define.ts";
import { jsonEqual } from "./diff.ts";
import { joinParamsFrom, ROOM_ID_RE, type DurableObjectNamespaceLike } from "./plugin.ts";
import { parseQueryObject } from "./query.ts";
import { RoomInstance, type Encoding, type RoomSnapshot } from "./room.ts";
import { parseShardId, pickShard, shardConfig, shardId, shardTokenPrefix, type ShardConfig, type ShardInfo } from "./shard.ts";

/** The parts of Cloudflare's hibernatable WebSocket we use. */
export interface CfWebSocket {
  send(message: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The parts of `DurableObjectState` we use. */
export interface DurableObjectStateLike {
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    /** Durable Object alarms: named timers and reconnect grace run from `alarm()`. */
    setAlarm?(scheduledTime: number): Promise<void>;
    deleteAlarm?(): Promise<void>;
  };
}

export interface RoomDurableObjectOptions {
  clock?: Clock;
  /** Override `new WebSocketPair()` (tests). Returns [client, server]. */
  webSocketPair?: () => readonly [unknown, CfWebSocket];
  /** This namespace's binding name, used by shards to reach their coordinator. Default `MIU_ROOMS`. */
  binding?: string;
}

interface Attachment {
  sid: string;
  type: string;
  /** Room instance id (`id:shardN` for a shard). */
  id: string;
  pid: string | null;
  /** Wire encoding chosen with ?enc= (absent: json). */
  enc?: Encoding;
}

/** What a coordinator object stores about its shards. */
interface Coordinator {
  data?: unknown;
  /** Seated players per shard: last report plus seats assigned since. */
  counts: Record<number, number>;
  /** Last reported state per shard (aggregate input). */
  states: Record<number, unknown>;
  aggregate?: unknown;
  hasAggregate?: boolean;
}

const SNAPSHOT_KEY = "miu:room";
const COORD_KEY = "miu:shards";
/** Header the Worker sets when forwarding a join to a shard object. */
export const SHARD_HEADER = "x-miu-shard";

declare const WebSocketPair: { new (): { 0: unknown; 1: CfWebSocket } } | undefined;

let seq = 0;

function internal(path: string, params: Record<string, string>, body?: unknown): Request {
  const u = new URL(`https://miu-room${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return body === undefined ? new Request(u) : new Request(u, { method: "POST", body: JSON.stringify(body) });
}

/** The public shape of the Durable Object class `createRoomDurableObject` returns. */
export interface RoomDurableObject {
  fetch(req: Request): Promise<Response>;
  webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: CfWebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  webSocketError(ws: CfWebSocket, err: unknown): Promise<void>;
  alarm(): Promise<void>;
}

export type RoomDurableObjectClass = new (state: DurableObjectStateLike, env: unknown) => RoomDurableObject;

/** Build the Durable Object class that hosts these room types. Export it from your Worker. */
export function createRoomDurableObject(roomTypes: readonly RoomType<any, any, any>[], opts: RoomDurableObjectOptions = {}): RoomDurableObjectClass {
  const types = new Map(roomTypes.map((r) => [r.type, r] as const));
  const known = [...types.keys()];
  const clock = opts.clock ?? systemClock;
  const binding = opts.binding ?? "MIU_ROOMS";
  const makePair =
    opts.webSocketPair ??
    (() => {
      if (typeof WebSocketPair === "undefined") throw new Error("WebSocketPair is only available on Cloudflare Workers");
      const p = new WebSocketPair();
      return [p[0], p[1]] as const;
    });

  return class MiuRoomsDurableObject {
    private ctx: DurableObjectStateLike;
    private env: Record<string, unknown> | undefined;
    private inst: RoomInstance | null = null;
    private loading: Promise<RoomInstance | null> | null = null;
    private sockets = new Map<CfWebSocket, MiuSocket>();
    /** Alarm time last set by this instance (`undefined`: unknown after a wake-up). */
    private armed: number | null | undefined = undefined;
    /** Shards: what was last reported to the coordinator, and the aggregate last published here. */
    private reported = "";
    private reporting: Promise<void> | null = null;
    private applied: { value: unknown } | null = null;

    constructor(state: DurableObjectStateLike, env: unknown) {
      this.ctx = state;
      this.env = env as Record<string, unknown> | undefined;
    }

    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/_miu/")) return await this.internal(req, url);
        const segs = url.pathname.split("/").filter(Boolean);
        const id = decodeURIComponent(segs[segs.length - 1] ?? "");
        const type = decodeURIComponent(segs[segs.length - 2] ?? "");
        const def = types.get(type);
        if (!def) {
          throw errors.custom({ code: "MIU_E_ROOM_TYPE_UNKNOWN", status: 404, message: `No room type "${type}"`, fix: `Use one of: ${known.join(", ")}, and pass the same rooms to createRoomDurableObject().` });
        }
        if (!ROOM_ID_RE.test(id)) throw errors.custom({ code: "MIU_E_ROOM_ID_INVALID", status: 400, message: "Invalid room id", fix: "Use 1-64 letters, digits, '_' or '-'." });
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          throw errors.custom({ code: "MIU_E_WS_EXPECTED", status: 426, message: "This route only accepts WebSocket connections", fix: "Connect with a WebSocket client (ws:// or wss://)." });
        }
        const cfg = shardConfig(def);
        const n = Number(req.headers.get(SHARD_HEADER) ?? "0");
        const instId = cfg ? shardId(id, Number.isInteger(n) && n >= 0 && n < cfg.maxShards ? n : 0) : id;
        const inst = (await this.load(type, instId, true))!;
        const [client, server] = makePair();
        this.ctx.acceptWebSocket(server);
        const join = joinParamsFrom(parseQueryObject(url.search));
        const att: Attachment = { sid: `cf_${Date.now().toString(36)}_${(++seq).toString(36)}`, type, id: instId, pid: null };
        if (join.enc === "msgpack") att.enc = "msgpack";
        server.serializeAttachment(att);
        const sock = this.wrap(server, att);
        inst.connect(sock, join);
        this.sync(server, sock, att);
        await this.persist();
        return new Response(null, { status: 101, webSocket: client } as ResponseInit);
      } catch (err) {
        if (err && typeof (err as any).toResponse === "function") return (err as any).toResponse();
        throw err;
      }
    }

    async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) return;
      const inst = await this.load(att.type, att.id, true);
      if (!inst) return;
      const sock = this.wrap(ws, att);
      await inst.receive(sock, message);
      this.sync(ws, sock, att);
      await this.persist();
    }

    async webSocketClose(ws: CfWebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) return;
      const inst = await this.load(att.type, att.id, false);
      const sock = this.sockets.get(ws);
      this.sockets.delete(ws);
      if (inst && sock) inst.disconnect(sock);
      await this.persist();
    }

    async webSocketError(ws: CfWebSocket, _err: unknown): Promise<void> {
      await this.webSocketClose(ws, 1011, "error", false);
    }

    /** Durable Object alarm: run due named timers and reconnect-grace expiries, then re-arm. */
    async alarm(): Promise<void> {
      const inst = await this.load("", "", false);
      if (!inst) return;
      await inst.runDue();
      await this.persist();
    }

    // ---- internal endpoints (Worker → object, shard ↔ coordinator) ----------------------

    private async internal(req: Request, url: URL): Promise<Response> {
      const type = url.searchParams.get("type") ?? "";
      const id = url.searchParams.get("id") ?? "";
      const def = types.get(type);
      const cfg = def ? shardConfig(def) : null;
      const body = req.method === "POST" ? ((await req.json().catch(() => null)) as Record<string, any> | null) ?? {} : {};
      switch (url.pathname) {
        case "/_miu/create": {
          // rooms().createRoom(): build the room now, with init data, before anyone joins.
          if (!def || !ROOM_ID_RE.test(id)) return errors.badRequest("Unknown room type or bad id", `Use one of: ${known.join(", ")}.`).toResponse();
          if (cfg) {
            const c = await this.coordinator();
            c.data = body.data ?? undefined;
            await this.ctx.storage.put(COORD_KEY, c);
          } else {
            await this.load(type, id, true, body.data ?? undefined);
            await this.persist();
          }
          return Response.json({ type, id });
        }
        case "/_miu/room": {
          const inst = await this.load(type, id, false);
          if (!inst) return errors.custom({ code: "MIU_E_ROOM_NOT_FOUND", status: 404, message: "No active room here", fix: "Join the room first." }).toResponse();
          return Response.json(inst.describe());
        }
        case "/_miu/shard/assign": {
          if (!cfg) break;
          const c = await this.coordinator();
          const n = pickShard((i) => c.counts[i] ?? 0, cfg, body.role);
          if (body.role !== "spectator") c.counts[n] = (c.counts[n] ?? 0) + 1;
          await this.ctx.storage.put(COORD_KEY, c);
          return Response.json({ shard: n });
        }
        case "/_miu/shard/data":
          return Response.json({ data: (await this.coordinator()).data ?? null });
        case "/_miu/shard/report": {
          if (!cfg) break;
          return Response.json(await this.onReport(type, id, cfg, body));
        }
        case "/_miu/shard/publish": {
          if (!cfg) break;
          const inst = await this.load(type, id, false);
          if (inst) {
            await this.applyAggregate(inst, cfg, body.aggregate);
            await this.persist();
          }
          return Response.json({ ok: true });
        }
      }
      return errors.notFound("internal endpoint", url.pathname).toResponse();
    }

    private async coordinator(): Promise<Coordinator> {
      return ((await this.ctx.storage.get(COORD_KEY)) as Coordinator | undefined) ?? { counts: {}, states: {} };
    }

    /** Coordinator: a shard reported its seats and state; recompute and fan out the aggregate. */
    private async onReport(type: string, id: string, cfg: ShardConfig, r: Record<string, any>): Promise<{ aggregate?: unknown }> {
      const c = await this.coordinator();
      const shard = Number(r.shard);
      c.counts[shard] = Number(r.players) || 0;
      c.states[shard] = r.state;
      if (!cfg.aggregate) {
        await this.ctx.storage.put(COORD_KEY, c);
        return {};
      }
      const shards: ShardInfo[] = Object.keys(c.states)
        .map(Number)
        .sort((a, b) => a - b)
        .map((n) => ({ shard: n, state: c.states[n], players: c.counts[n] ?? 0 }));
      const agg = cfg.aggregate(shards);
      const changed = !c.hasAggregate || !jsonEqual(agg, c.aggregate);
      c.aggregate = agg;
      c.hasAggregate = true;
      await this.ctx.storage.put(COORD_KEY, c);
      const ns = this.namespace();
      if (changed && cfg.publish && ns) {
        // The reporting shard gets the aggregate in the response; push it to the others.
        await Promise.all(
          shards
            .filter((s) => s.shard !== shard)
            .map((s) => ns.get(ns.idFromName(`${type}:${shardId(id, s.shard)}`)).fetch(internal("/_miu/shard/publish", { type, id: shardId(id, s.shard) }, { aggregate: agg })).catch(() => null)),
        );
      }
      return { aggregate: agg };
    }

    private async applyAggregate(inst: RoomInstance, cfg: ShardConfig, agg: unknown): Promise<void> {
      if (!cfg.publish || (this.applied && jsonEqual(this.applied.value, agg))) return;
      this.applied = { value: agg };
      await inst.update((room) => cfg.publish!({ room, aggregate: agg }), "shards.publish");
    }

    /** Shard: tell the coordinator about seats and state (when they changed). */
    private async report(inst: RoomInstance): Promise<void> {
      const def = types.get(inst.type);
      const cfg = def ? shardConfig(def) : null;
      const sh = cfg ? parseShardId(inst.id) : null;
      const ns = this.namespace();
      if (!cfg || !sh || !ns) return;
      const state = inst.describe().state;
      const key = JSON.stringify([inst.seated, state]);
      // Same news already on its way (e.g. from the onChange persist): wait for that report.
      if (key === this.reported) return void (await this.reporting);
      this.reported = key;
      const p = this.sendReport(inst, cfg, sh, ns, state);
      this.reporting = p.catch(() => {});
      await p;
    }

    private async sendReport(inst: RoomInstance, cfg: ShardConfig, sh: { id: string; shard: number }, ns: DurableObjectNamespaceLike, state: unknown): Promise<void> {
      const res = await ns
        .get(ns.idFromName(`${inst.type}:${sh.id}`))
        .fetch(internal("/_miu/shard/report", { type: inst.type, id: sh.id }, { shard: sh.shard, players: inst.seated, state }));
      const body = (await res.json().catch(() => ({}))) as { aggregate?: unknown };
      if ("aggregate" in body) await this.applyAggregate(inst, cfg, body.aggregate);
    }

    private namespace(): DurableObjectNamespaceLike | null {
      const ns = this.env?.[binding] as DurableObjectNamespaceLike | undefined;
      return ns && typeof ns.idFromName === "function" ? ns : null;
    }

    // ---- room instance ------------------------------------------------------------------

    private wrap(ws: CfWebSocket, att: Attachment): MiuSocket {
      let s = this.sockets.get(ws);
      if (!s) {
        s = { id: att.sid, data: undefined, send: (m) => ws.send(m), close: (c, r) => ws.close(c, r) };
        this.sockets.set(ws, s);
      }
      return s;
    }

    /** Record which player a socket belongs to, so hibernation can re-attach it. */
    private sync(ws: CfWebSocket, sock: MiuSocket, att: Attachment): void {
      const pid = this.inst?.playerOf(sock) ?? null;
      if (pid !== att.pid) {
        att.pid = pid;
        ws.serializeAttachment(att);
      }
    }

    private load(type: string, id: string, create: boolean, data?: unknown): Promise<RoomInstance | null> {
      if (this.inst && !this.inst.isClosed) return Promise.resolve(this.inst);
      return (this.loading ??= this.doLoad(type, id, create, data).finally(() => (this.loading = null)));
    }

    private async doLoad(type: string, id: string, create: boolean, data?: unknown): Promise<RoomInstance | null> {
      const snap = (await this.ctx.storage.get(SNAPSHOT_KEY)) as RoomSnapshot | undefined;
      const def = types.get(snap?.type ?? type);
      if (!def || (!snap && !create)) return null;
      const instId = snap?.id ?? id;
      const sh = shardConfig(def) ? parseShardId(instId) : null;
      if (sh && !snap && data === undefined) {
        // A new shard: fetch the room's creation data from the coordinator.
        const ns = this.namespace();
        const res = ns ? await ns.get(ns.idFromName(`${def.type}:${sh.id}`)).fetch(internal("/_miu/shard/data", { type: def.type, id: sh.id })) : null;
        data = res ? (((await res.json().catch(() => ({}))) as { data?: unknown }).data ?? undefined) : undefined;
      }
      const storage: RoomStorage = {
        get: (k) => this.ctx.storage.get(`u:${k}`) as Promise<any>,
        put: (k, v) => this.ctx.storage.put(`u:${k}`, v),
        delete: (k) => this.ctx.storage.delete(`u:${k}`),
      };
      const inst: RoomInstance = new RoomInstance(def, {
        id: instId,
        data,
        clock,
        storage,
        restore: snap,
        durable: true,
        env: this.env ?? {},
        tokenPrefix: sh ? shardTokenPrefix(sh.shard) : undefined,
        hooks: {
          onChange: () => void this.persist().catch(() => {}),
          onEmpty: () => {
            if (inst.connections === 0) inst.close("room empty");
          },
          onClose: () => {
            void this.ctx.storage.delete(SNAPSHOT_KEY).catch(() => {});
            this.armed = null;
            void this.ctx.storage.deleteAlarm?.().catch(() => {});
          },
        },
      });
      this.inst = inst;
      // Re-attach sockets that stayed open while this object hibernated.
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (!att) continue;
        const sock = this.wrap(ws, att);
        if (att.pid) inst.attach(sock, att.pid, att.enc);
      }
      return inst;
    }

    private async persist(): Promise<void> {
      const inst = this.inst;
      if (!inst || inst.isClosed) return;
      await this.ctx.storage.put(SNAPSHOT_KEY, inst.snapshot());
      // The snapshot holds pending timers and grace deadlines; the alarm wakes us for the earliest.
      const due = inst.nextDue();
      if (due !== this.armed) {
        this.armed = due;
        const s = this.ctx.storage;
        if (due === null) await s.deleteAlarm?.();
        else await s.setAlarm?.(due);
      }
      await this.report(inst).catch(() => {});
    }
  };
}
