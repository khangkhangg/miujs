// Cloudflare transport: one Durable Object per room (named "type:id"). Uses the WebSocket
// hibernation API so idle rooms cost nothing; state, players and resume tokens are persisted
// to DO storage and restored when the object wakes up.
//
//   export const MiuRooms = createRoomDurableObject([quiz]);   // wrangler: binding MIU_ROOMS

import { errors, type MiuSocket } from "miujs";
import { systemClock, type Clock } from "./clock.ts";
import type { RoomStorage, RoomType } from "./define.ts";
import { joinParamsFrom, ROOM_ID_RE } from "./plugin.ts";
import { parseQueryObject } from "./query.ts";
import { RoomInstance, type RoomSnapshot } from "./room.ts";

/** The parts of Cloudflare's hibernatable WebSocket we use. */
export interface CfWebSocket {
  send(message: string): void;
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
  };
}

export interface RoomDurableObjectOptions {
  clock?: Clock;
  /** Override `new WebSocketPair()` (tests). Returns [client, server]. */
  webSocketPair?: () => readonly [unknown, CfWebSocket];
}

interface Attachment {
  sid: string;
  type: string;
  id: string;
  pid: string | null;
}

const SNAPSHOT_KEY = "miu:room";

declare const WebSocketPair: { new (): { 0: unknown; 1: CfWebSocket } } | undefined;

let seq = 0;

/** Build the Durable Object class that hosts these room types. Export it from your Worker. */
export function createRoomDurableObject(roomTypes: readonly RoomType<any, any, any>[], opts: RoomDurableObjectOptions = {}) {
  const types = new Map(roomTypes.map((r) => [r.type, r] as const));
  const known = [...types.keys()];
  const clock = opts.clock ?? systemClock;
  const makePair =
    opts.webSocketPair ??
    (() => {
      if (typeof WebSocketPair === "undefined") throw new Error("WebSocketPair is only available on Cloudflare Workers");
      const p = new WebSocketPair();
      return [p[0], p[1]] as const;
    });

  return class MiuRoomsDurableObject {
    private ctx: DurableObjectStateLike;
    private inst: RoomInstance | null = null;
    private loading: Promise<RoomInstance | null> | null = null;
    private sockets = new Map<CfWebSocket, MiuSocket>();

    constructor(state: DurableObjectStateLike, _env: unknown) {
      this.ctx = state;
    }

    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        if (url.pathname === "/_miu/room") {
          const inst = await this.load(url.searchParams.get("type") ?? "", url.searchParams.get("id") ?? "", false);
          if (!inst) return errors.custom({ code: "MIU_E_ROOM_NOT_FOUND", status: 404, message: "No active room here", fix: "Join the room first." }).toResponse();
          return Response.json(inst.describe());
        }
        const segs = url.pathname.split("/").filter(Boolean);
        const id = decodeURIComponent(segs[segs.length - 1] ?? "");
        const type = decodeURIComponent(segs[segs.length - 2] ?? "");
        if (!types.has(type)) {
          throw errors.custom({ code: "MIU_E_ROOM_TYPE_UNKNOWN", status: 404, message: `No room type "${type}"`, fix: `Use one of: ${known.join(", ")}, and pass the same rooms to createRoomDurableObject().` });
        }
        if (!ROOM_ID_RE.test(id)) throw errors.custom({ code: "MIU_E_ROOM_ID_INVALID", status: 400, message: "Invalid room id", fix: "Use 1-64 letters, digits, '_' or '-'." });
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          throw errors.custom({ code: "MIU_E_WS_EXPECTED", status: 426, message: "This route only accepts WebSocket connections", fix: "Connect with a WebSocket client (ws:// or wss://)." });
        }
        const inst = (await this.load(type, id, true))!;
        const [client, server] = makePair();
        this.ctx.acceptWebSocket(server);
        const att: Attachment = { sid: `cf_${Date.now().toString(36)}_${(++seq).toString(36)}`, type, id, pid: null };
        server.serializeAttachment(att);
        const sock = this.wrap(server, att);
        inst.connect(sock, joinParamsFrom(parseQueryObject(url.search)));
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

    private wrap(ws: CfWebSocket, att: Attachment): MiuSocket {
      let s = this.sockets.get(ws);
      if (!s) {
        s = { id: att.sid, data: undefined, send: (m) => ws.send(m as string), close: (c, r) => ws.close(c, r) };
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

    private load(type: string, id: string, create: boolean): Promise<RoomInstance | null> {
      if (this.inst && !this.inst.isClosed) return Promise.resolve(this.inst);
      return (this.loading ??= this.doLoad(type, id, create).finally(() => (this.loading = null)));
    }

    private async doLoad(type: string, id: string, create: boolean): Promise<RoomInstance | null> {
      const snap = (await this.ctx.storage.get(SNAPSHOT_KEY)) as RoomSnapshot | undefined;
      const def = types.get(snap?.type ?? type);
      if (!def || (!snap && !create)) return null;
      const storage: RoomStorage = {
        get: (k) => this.ctx.storage.get(`u:${k}`) as Promise<any>,
        put: (k, v) => this.ctx.storage.put(`u:${k}`, v),
        delete: (k) => this.ctx.storage.delete(`u:${k}`),
      };
      const inst: RoomInstance = new RoomInstance(def, {
        id: snap?.id ?? id,
        clock,
        storage,
        restore: snap,
        hooks: {
          onChange: () => void this.persist().catch(() => {}),
          onEmpty: () => {
            if (inst.connections === 0) inst.close("room empty");
          },
          onClose: () => void this.ctx.storage.delete(SNAPSHOT_KEY).catch(() => {}),
        },
      });
      this.inst = inst;
      // Re-attach sockets that stayed open while this object hibernated.
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (!att) continue;
        const sock = this.wrap(ws, att);
        if (att.pid) inst.attach(sock, att.pid);
      }
      return inst;
    }

    private async persist(): Promise<void> {
      const inst = this.inst;
      if (!inst || inst.isClosed) return;
      await this.ctx.storage.put(SNAPSHOT_KEY, inst.snapshot());
    }
  };
}
