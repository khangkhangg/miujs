import type { Context } from "../core/context.ts";
import { problem } from "../core/errors.ts";
import type { CfWebSocket, DurableObjectNamespace, DurableObjectState } from "./cf-types.ts";
import type { WsForward, WsSendable } from "./types.ts";
import { getWebSocketPair } from "./workers.ts";
import { isUpgradeRequest, upgradeRequired } from "./upgrade.ts";

/** Optional per-room handlers, an alternative to overriding the `on*` methods. */
export interface RoomHandlers<D = unknown> {
  open?(ws: CfWebSocket, room: MiuRoom<D>): unknown;
  message?(ws: CfWebSocket, msg: string | ArrayBuffer, room: MiuRoom<D>): unknown;
  close?(ws: CfWebSocket, code: number, reason: string, room: MiuRoom<D>): unknown;
  error?(ws: CfWebSocket, err: unknown, room: MiuRoom<D>): unknown;
}

/** What `onConnect` may return: per-socket data (persisted across hibernation) and tags. */
export interface RoomConnect<D> {
  data?: D;
  tags?: string[];
}

export interface RoomMemberInfo<D> {
  ws: CfWebSocket;
  data: D | undefined;
  tags: string[];
}

/**
 * Durable Object base class for a WebSocket room using the Hibernation API:
 * the DO can be evicted while sockets stay connected. Subclass and override
 * `onConnect/onOpen/onMessage/onClose/onError`, or set `handlers`.
 *
 * ```ts
 * export class QuizRoom extends MiuRoom<{ name: string }> {
 *   override onMessage(ws, msg) { this.broadcast(msg, { except: ws }); }
 * }
 * ```
 */
export class MiuRoom<D = unknown, Env = unknown> {
  readonly state: DurableObjectState;
  readonly env: Env;
  handlers: RoomHandlers<D> = {};
  private fallbackData = new WeakMap<CfWebSocket, D>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Accept or reject a connection. Return a Response to reject. */
  onConnect(_req: Request): RoomConnect<D> | Response | void | Promise<RoomConnect<D> | Response | void> {}
  onOpen(ws: CfWebSocket): unknown {
    return this.handlers.open?.(ws, this);
  }
  onMessage(ws: CfWebSocket, msg: string | ArrayBuffer): unknown {
    return this.handlers.message?.(ws, msg, this);
  }
  onClose(ws: CfWebSocket, code: number, reason: string): unknown {
    return this.handlers.close?.(ws, code, reason, this);
  }
  onError(ws: CfWebSocket, err: unknown): unknown {
    if (this.handlers.error) return this.handlers.error(ws, err, this);
    console.error("[miu] room error:", err);
  }

  async fetch(req: Request): Promise<Response> {
    if (!isUpgradeRequest(req)) return upgradeRequired();
    const Pair = getWebSocketPair();
    if (!Pair) return problem(501, { detail: "WebSocketPair is not available in this runtime" });
    const accepted = await this.onConnect(req);
    if (accepted instanceof Response) return accepted;
    const pair = new Pair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, accepted?.tags ?? []);
    if (accepted && "data" in accepted) this.setData(server, accepted.data as D);
    await this.guard(server, () => this.onOpen(server));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  // ----- Hibernation API entry points (called by the runtime) -----
  async webSocketMessage(ws: CfWebSocket, msg: string | ArrayBuffer): Promise<void> {
    await this.guard(ws, () => this.onMessage(ws, msg));
  }

  async webSocketClose(ws: CfWebSocket, code: number, reason: string, _wasClean?: boolean): Promise<void> {
    await this.guard(ws, () => this.onClose(ws, code, reason));
    try {
      ws.close(code, reason); // complete the closing handshake
    } catch {
      // reserved codes (1005/1006) or already closed
    }
  }

  async webSocketError(ws: CfWebSocket, err: unknown): Promise<void> {
    try {
      await this.onError(ws, err);
    } catch (e) {
      console.error("[miu] room error handler failed:", e);
    }
  }

  // ----- helpers -----
  /** Connected sockets, optionally filtered by tag. Survives hibernation. */
  sockets(tag?: string): CfWebSocket[] {
    return this.state.getWebSockets(tag);
  }

  dataOf(ws: CfWebSocket): D | undefined {
    if (ws.deserializeAttachment) return (ws.deserializeAttachment() ?? undefined) as D | undefined;
    return this.fallbackData.get(ws);
  }

  /** Update a socket's data (persisted via serializeAttachment when available). */
  setData(ws: CfWebSocket, data: D): void {
    if (ws.serializeAttachment) ws.serializeAttachment(data);
    else this.fallbackData.set(ws, data);
  }

  /** Presence list: every connected socket with its data and tags. */
  members(tag?: string): RoomMemberInfo<D>[] {
    return this.sockets(tag).map((ws) => ({ ws, data: this.dataOf(ws), tags: this.state.getTags?.(ws) ?? [] }));
  }

  /** Send to every socket (objects JSON-encoded). Returns the number delivered. */
  broadcast(message: unknown, opts: { except?: CfWebSocket | CfWebSocket[]; tag?: string } = {}): number {
    const except = opts.except === undefined ? [] : Array.isArray(opts.except) ? opts.except : [opts.except];
    const data: WsSendable =
      typeof message === "string" || message instanceof ArrayBuffer || ArrayBuffer.isView(message)
        ? (message as WsSendable)
        : JSON.stringify(message);
    let sent = 0;
    for (const ws of this.sockets(opts.tag)) {
      if (except.includes(ws)) continue;
      try {
        ws.send(data);
        sent++;
      } catch {
        // socket closing
      }
    }
    return sent;
  }

  private async guard(ws: CfWebSocket, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      await this.webSocketError(ws, err);
    }
  }
}

type Resolve<T> = T | ((c: Context<any, any>) => T);

/**
 * Forward a WebSocket upgrade to a Durable Object room, after Miu's
 * middleware has run: `app.ws("/quiz/:id", roomRoute((c) => c.env.QUIZ, (c) => c.params.id))`.
 */
export function roomRoute(
  namespace: Resolve<DurableObjectNamespace>,
  name: (c: Context<any, any>) => string | Promise<string>,
): WsForward {
  return async (c) => {
    const ns = typeof namespace === "function" ? namespace(c) : namespace;
    const stub = ns.get(ns.idFromName(await name(c)));
    return stub.fetch(c.req);
  };
}
