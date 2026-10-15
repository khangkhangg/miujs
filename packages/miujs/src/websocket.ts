// One WebSocket API across runtimes. Handlers see a `MiuSocket`; this file maps it onto
// Bun's server.upgrade, Deno.upgradeWebSocket and Workers' WebSocketPair.

import { RequestContext, _setUpgradeImpl } from "./context.ts";
import { errors } from "./errors.ts";

export type SocketMessage = string | Uint8Array;

export interface MiuSocket<D = any> {
  readonly id: string;
  /** Per-connection data you can read and write. */
  data: D;
  send(message: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketHandlers<D = any> {
  /** Initial value of `socket.data`. */
  data?: D;
  open?(socket: MiuSocket<D>): void | Promise<void>;
  message?(socket: MiuSocket<D>, message: SocketMessage): void | Promise<void>;
  close?(socket: MiuSocket<D>, code: number, reason: string): void | Promise<void>;
}

declare const Deno: { upgradeWebSocket(req: Request): { socket: WebSocket; response: Response } } | undefined;
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket & { accept(): void } } } | undefined;

let nextId = 0;
function socketId(): string {
  return `ws_${Date.now().toString(36)}_${(++nextId).toString(36)}`;
}

function normalize(message: unknown): SocketMessage {
  if (typeof message === "string") return message;
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return String(message);
}

function wireStandard(ws: WebSocket, handlers: WebSocketHandlers, onError: (err: unknown) => void): MiuSocket {
  const socket: MiuSocket = {
    id: socketId(),
    data: handlers.data,
    send: (m) => ws.send(m as string),
    close: (code, reason) => ws.close(code, reason),
  };
  const guard = (p: void | Promise<void>) => {
    if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(onError);
  };
  ws.addEventListener("open", () => guard(handlers.open?.(socket)));
  ws.addEventListener("message", (e: MessageEvent) => guard(handlers.message?.(socket, normalize(e.data))));
  ws.addEventListener("close", (e: CloseEvent) => guard(handlers.close?.(socket, e.code, e.reason)));
  return socket;
}

interface BunSocketData {
  handlers: WebSocketHandlers;
  socket?: MiuSocket;
  onError: (err: unknown) => void;
}

interface BunWs {
  data: BunSocketData;
  send(m: unknown): void;
  close(code?: number, reason?: string): void;
}

/** Passed to `Bun.serve({ websocket })`. Dispatches to the handlers given to `ctx.upgrade`. */
export const bunWebSocket = {
  open(ws: BunWs) {
    const d = ws.data;
    d.socket = {
      id: socketId(),
      data: d.handlers.data,
      send: (m) => ws.send(m),
      close: (code, reason) => ws.close(code, reason),
    };
    run(d, d.handlers.open?.(d.socket));
  },
  message(ws: BunWs, message: unknown) {
    const d = ws.data;
    if (d.socket) run(d, d.handlers.message?.(d.socket, normalize(message)));
  },
  close(ws: BunWs, code: number, reason: string) {
    const d = ws.data;
    if (d.socket) run(d, d.handlers.close?.(d.socket, code, reason));
  },
};

function run(d: BunSocketData, p: void | Promise<void>) {
  if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(d.onError);
}

function upgrade(ctx: RequestContext, handlers: WebSocketHandlers): Response {
  if (ctx.req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw errors.custom({
      code: "MIU_E_WS_EXPECTED",
      status: 426,
      message: "This route only accepts WebSocket connections",
      fix: "Connect with a WebSocket client (ws:// or wss://), not plain HTTP.",
    });
  }
  const onError = (err: unknown) => ctx.log.error("websocket handler failed", { err });
  const platform = ctx._platform;

  if (platform.bunServer) {
    const data: BunSocketData = { handlers, onError };
    if (!platform.bunServer.upgrade(ctx.req, { data })) {
      throw errors.badRequest("WebSocket upgrade failed");
    }
    ctx._upgraded = true;
    // Bun owns the connection now; the app returns `undefined` to Bun.serve.
    return new Response(null, { status: 200 });
  }

  if (typeof WebSocketPair !== "undefined") {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const socket = wireStandard(server, handlers, onError);
    // Workers sockets are already open after accept(); fire open ourselves.
    queueMicrotask(() => {
      const p = handlers.open?.(socket);
      if (p) p.catch(onError);
    });
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  if (typeof Deno !== "undefined") {
    const { socket, response } = Deno.upgradeWebSocket(ctx.req);
    wireStandard(socket, handlers, onError);
    return response;
  }

  throw errors.custom({
    code: "MIU_E_WS_UNSUPPORTED",
    status: 501,
    message: `WebSockets are not supported on runtime "${ctx.runtime}" yet`,
    fix: "Run realtime routes on Bun, Deno or Cloudflare Workers.",
  });
}

_setUpgradeImpl(upgrade);
