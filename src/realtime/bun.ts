import { BaseSocket, toMessage } from "./lifecycle.ts";
import type { WsHandlers, WsSendable } from "./types.ts";

/** The parts of Bun's `Server` used for upgrades. */
export interface BunServerLike {
  upgrade(req: Request, opts?: { data?: unknown; headers?: HeadersInit }): boolean;
  publish(topic: string, data: WsSendable): unknown;
}

/** The parts of Bun's `ServerWebSocket` used here. */
export interface BunWebSocketLike {
  data: { miu?: BunSocket<any> } & Record<string, unknown>;
  readyState: number;
  send(data: WsSendable): unknown;
  close(code?: number, reason?: string): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: WsSendable): unknown;
}

/** Bun's `Bun.serve({ fetch(req, server) })` passes the server as the 2nd argument. */
export function isBunServer(x: unknown): x is BunServerLike {
  return !!x && typeof (x as BunServerLike).upgrade === "function" && typeof (x as BunServerLike).publish === "function";
}

export class BunSocket<D = unknown> extends BaseSocket<D> {
  ws!: BunWebSocketLike;
  get raw(): unknown {
    return this.ws;
  }
  get readyState(): number {
    return this.ws?.readyState ?? 0;
  }
  send(data: WsSendable): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
  subscribe(topic: string): void {
    this.ws.subscribe(topic);
  }
  unsubscribe(topic: string): void {
    this.ws.unsubscribe(topic);
  }
  publish(topic: string, data: WsSendable): void {
    this.ws.publish(topic, data);
  }
}

/** Upgrade via `server.upgrade()`; Bun then drives `bunWebSocket`. */
export function upgradeBun(
  server: BunServerLike,
  req: Request,
  handlers: WsHandlers<any>,
  data: unknown,
  headers: Headers,
): Response | null {
  const socket = new BunSocket(handlers, data);
  if (!server.upgrade(req, { data: { miu: socket }, headers })) return null;
  // Bun ignores the response after a successful upgrade; this keeps middleware happy.
  return new Response(null, { status: 101 });
}

const socketOf = (ws: BunWebSocketLike): BunSocket<any> | undefined => {
  const s = ws.data?.miu;
  if (s && !s.ws) s.ws = ws;
  return s;
};

/** Bun `websocket` handler shared by every Miu app (state lives on `ws.data`). */
export const bunWebSocket = {
  open(ws: BunWebSocketLike) {
    return socketOf(ws)?.open();
  },
  message(ws: BunWebSocketLike, message: string | Uint8Array) {
    return socketOf(ws)?.message(toMessage(message));
  },
  close(ws: BunWebSocketLike, code: number, reason: string) {
    return socketOf(ws)?.closed(code, reason);
  },
};
