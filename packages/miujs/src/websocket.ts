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
  /**
   * Browser origins (exact, e.g. "https://play.example") allowed to open this socket while
   * carrying cookies, besides the page's own origin; "*" allows any. A cross-origin handshake
   * with cookies is otherwise refused (403), which stops cross-site WebSocket hijacking: a
   * hostile page riding the player's session. Handshakes without cookies (token auth) are not
   * affected.
   */
  origins?: readonly string[] | "*";
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

const utf8Encoder = new TextEncoder();

/** Whether a received message is over `max` bytes (strings as UTF-8: 1 to 3 bytes per UTF-16 unit). */
function tooBig(data: unknown, max: number): boolean {
  if (typeof data === "string") return data.length * 3 > max && (data.length > max || utf8Encoder.encode(data).byteLength > max);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength > max;
  if (data instanceof Blob) return data.size > max;
  return false;
}

function wireStandard(ws: WebSocket, handlers: WebSocketHandlers, onError: (err: unknown) => void, maxPayload: number): MiuSocket {
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
  ws.addEventListener("message", (e: MessageEvent) => {
    // These runtimes have no frame-size option: the message is already read, but it never reaches
    // the handler, and the client is told why (1009 = message too big).
    if (tooBig(e.data, maxPayload)) return ws.close(1009, "Message too big");
    guard(handlers.message?.(socket, normalize(e.data)));
  });
  ws.addEventListener("close", (e: CloseEvent) => guard(handlers.close?.(socket, e.code, e.reason)));
  return socket;
}

interface BunSocketData {
  handlers: WebSocketHandlers;
  socket?: MiuSocket;
  onError: (err: unknown) => void;
}

export interface BunWs {
  data: BunSocketData;
  /** Bytes sent, -1 when queued under backpressure, 0 when dropped (past backpressureLimit, or closed). */
  send(m: unknown): number;
  close(code?: number, reason?: string): void;
}

/** `miu({ websocket })`: per-connection limits, in bytes. */
export interface WebSocketLimits {
  /**
   * Largest message a client may send. A bigger frame closes the socket with 1009 as soon as its
   * header arrives (Bun), so it is never buffered. Default 1 MiB.
   */
  maxPayloadLength?: number;
  /**
   * Most bytes the server buffers for a client that is not reading. Past it the socket is closed
   * (Bun), so a slow or stalled client cannot grow the server's memory. Default 1 MiB.
   */
  backpressureLimit?: number;
}

export const WS_LIMIT_DEFAULT = 1024 * 1024;

/** Checked limits with defaults filled in. Throws MIU_E_WS_LIMIT_INVALID. */
export function resolveWebSocketLimits(limits: WebSocketLimits = {}): Required<WebSocketLimits> {
  const out = { maxPayloadLength: limits.maxPayloadLength ?? WS_LIMIT_DEFAULT, backpressureLimit: limits.backpressureLimit ?? WS_LIMIT_DEFAULT };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw errors.config("MIU_E_WS_LIMIT_INVALID", `websocket.${k} must be a positive whole number of bytes, got ${JSON.stringify(v)}`, `Pass a byte count, e.g. miu({ websocket: { ${k}: 1024 * 1024 } }).`);
    }
  }
  return out;
}

/** The `websocket` object for `Bun.serve` (and `export default app`), with these limits. */
export function bunWebSocketHandler(limits: Required<WebSocketLimits>) {
  return { ...bunWebSocket, maxPayloadLength: limits.maxPayloadLength, backpressureLimit: limits.backpressureLimit, closeOnBackpressureLimit: true };
}

/** Passed to `Bun.serve({ websocket })`. Dispatches to the handlers given to `ctx.upgrade`. */
const bunWebSocket = {
  open(ws: BunWs) {
    const d = ws.data;
    d.socket = {
      id: socketId(),
      data: d.handlers.data,
      send: (m) => sendOrClose(ws, m),
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

/**
 * Bun drops a frame (send → 0) once more than backpressureLimit bytes wait for a client that is
 * not reading, but keeps the socket open even with closeOnBackpressureLimit (Bun 1.4). Close it:
 * a client that missed frames is out of sync anyway, and a stalled one must not hold memory.
 * The result is still returned, so callers that check it (realtime rooms) see the drop.
 */
function sendOrClose(ws: BunWs, m: unknown): number {
  const r = ws.send(m);
  if (r === 0) ws.close(1013, "Client is not reading fast enough");
  return r;
}

function run(d: BunSocketData, p: void | Promise<void>) {
  if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(d.onError);
}

function checkOrigin(ctx: RequestContext, origins: WebSocketHandlers["origins"]): void {
  const headers = ctx.req.headers;
  const origin = headers.get("origin");
  // Only a browser sends Origin, and only ambient cookies make a cross-site handshake dangerous.
  if (origin === null || origins === "*" || !headers.has("cookie")) return;
  if (origins && origins.includes(origin)) return;
  let same = false;
  try {
    same = new URL(origin).host === ctx.url.host;
  } catch {}
  if (same) return;
  throw errors.custom({
    code: "MIU_E_WS_ORIGIN",
    status: 403,
    message: `WebSocket connections with cookies from ${origin} are not allowed`,
    fix: 'Serve the page from the same origin, or list it: ctx.upgrade({ origins: ["https://your.site"], ... }).',
  });
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
  checkOrigin(ctx, handlers.origins);
  // Capture the logger only: a closure over `ctx` would keep the Request (cookies, Authorization)
  // alive for as long as the socket is open.
  const log = ctx.log;
  const onError = (err: unknown) => log.error("websocket handler failed", { err });
  const platform = ctx._platform;
  const maxPayload = platform.wsMaxPayload ?? WS_LIMIT_DEFAULT;

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
    const socket = wireStandard(server, handlers, onError, maxPayload);
    // Workers sockets are already open after accept(); fire open ourselves.
    queueMicrotask(() => {
      const p = handlers.open?.(socket);
      if (p) p.catch(onError);
    });
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  if (typeof Deno !== "undefined") {
    const { socket, response } = Deno.upgradeWebSocket(ctx.req);
    wireStandard(socket, handlers, onError, maxPayload);
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
