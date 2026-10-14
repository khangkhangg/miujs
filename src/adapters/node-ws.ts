/**
 * Minimal, dependency-free RFC 6455 WebSocket server for the Node adapter.
 *
 * It plugs into the realtime core through the same `{ upgrade, publish }`
 * shape Bun's server has (see `BunServerLike`), so `app.ws()` handlers run
 * unchanged. Only the Node adapter imports this file.
 *
 * Security limits: max message size (`maxPayload`, checked from the frame
 * header before buffering, fragments included), unmasked client frames are
 * rejected, RSV bits / unknown opcodes / malformed control frames close with
 * 1002, invalid UTF-8 with 1007, idle connections are pinged then dropped, a
 * peer that never completes the close handshake is destroyed, and a client
 * that stops reading is dropped once `maxBufferedAmount` bytes are queued.
 */
import { createHash } from "node:crypto";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BunServerLike, BunWebSocketLike } from "../realtime/bun.ts";
import type { WsSendable } from "../realtime/types.ts";

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export interface NodeWsOptions {
  /** Max size of one message in bytes (all fragments together). Default 1 MiB. */
  maxPayload?: number;
  /** Seconds without traffic before the server pings; the connection drops if the next period is silent too. Default 120; 0 disables. */
  idleTimeout?: number;
  /** Bytes queued for a slow client before it is disconnected. Default 16 MiB. */
  maxBufferedAmount?: number;
  /** Milliseconds to wait for the peer's close frame before destroying the socket. Default 5000. */
  closeTimeout?: number;
}

export type WsEvent =
  | { type: "message"; data: string | Uint8Array }
  | { type: "ping"; data: Uint8Array }
  | { type: "pong"; data: Uint8Array }
  | { type: "close"; code: number; reason: string };

export class WsProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** `Sec-WebSocket-Accept` for a client key. */
export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Close codes a peer may send (RFC 6455 7.4). */
export function isValidCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

const toBytes = (data: WsSendable | string): Uint8Array =>
  typeof data === "string"
    ? encoder.encode(data)
    : data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);

/** Encode one frame. Server frames are unmasked; pass `mask` to build client frames. */
export function encodeFrame(opcode: number, payload: WsSendable | string, opts: { fin?: boolean; mask?: Uint8Array } = {}): Uint8Array {
  const data = toBytes(payload);
  const len = data.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const mask = opts.mask;
  const head = 2 + ext + (mask ? 4 : 0);
  const out = new Uint8Array(head + len);
  out[0] = (opts.fin === false ? 0 : 0x80) | opcode;
  out[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) {
    out[2] = len >>> 8;
    out[3] = len & 0xff;
  } else if (ext === 8) {
    new DataView(out.buffer).setBigUint64(2, BigInt(len));
  }
  if (mask) {
    out.set(mask, head - 4);
    for (let i = 0; i < len; i++) out[head + i] = data[i]! ^ mask[i & 3]!;
  } else {
    out.set(data, head);
  }
  return out;
}

/**
 * Incremental frame parser + message assembler. `push()` returns complete
 * messages and control frames; violations throw `WsProtocolError` with the
 * close code to send.
 */
export class FrameParser {
  private readonly maxPayload: number;
  private readonly requireMask: boolean;
  private head = new Uint8Array(14);
  private headLen = 0;
  // Current frame
  private fin = false;
  private opcode = 0;
  private mask: Uint8Array | null = null;
  private payload: Uint8Array | null = null;
  private got = 0;
  // Current fragmented message
  private fragOpcode = 0;
  private fragments: Uint8Array[] = [];
  private fragBytes = 0;

  constructor(opts: { maxPayload: number; requireMask: boolean }) {
    this.maxPayload = opts.maxPayload;
    this.requireMask = opts.requireMask;
  }

  push(chunk: Uint8Array): WsEvent[] {
    const out: WsEvent[] = [];
    let off = 0;
    const n = chunk.length;
    while (off < n || (this.payload && this.got === this.payload.length)) {
      if (!this.payload) {
        this.head[this.headLen++] = chunk[off++]!;
        if (this.headLen < this.headerSize()) continue;
        this.startFrame();
      } else {
        const take = Math.min(this.payload.length - this.got, n - off);
        this.payload.set(chunk.subarray(off, off + take), this.got);
        this.got += take;
        off += take;
      }
      if (this.payload && this.got === this.payload.length) this.endFrame(out);
    }
    return out;
  }

  private headerSize(): number {
    if (this.headLen < 2) return 2;
    const len7 = this.head[1]! & 0x7f;
    return 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (this.head[1]! & 0x80 ? 4 : 0);
  }

  private startFrame(): void {
    const b0 = this.head[0]!;
    const b1 = this.head[1]!;
    this.fin = (b0 & 0x80) !== 0;
    this.opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    if (b0 & 0x70) throw new WsProtocolError(1002, "RSV bits set without a negotiated extension");
    const control = this.opcode >= 0x8;
    if (control ? this.opcode > 0xa : this.opcode > 0x2) throw new WsProtocolError(1002, `Unknown opcode ${this.opcode}`);
    if (this.requireMask && !masked) throw new WsProtocolError(1002, "Client frames must be masked");
    let len = b1 & 0x7f;
    let p = 2;
    if (len === 126) {
      len = (this.head[2]! << 8) | this.head[3]!;
      p = 4;
    } else if (len === 127) {
      const dv = new DataView(this.head.buffer, 2, 8);
      const hi = dv.getUint32(0);
      if (hi > 0x1fffff) throw new WsProtocolError(1009, "Frame too large");
      len = hi * 2 ** 32 + dv.getUint32(4);
      p = 10;
    }
    if (control) {
      if (!this.fin) throw new WsProtocolError(1002, "Fragmented control frame");
      if (len > 125) throw new WsProtocolError(1002, "Control frame too large");
    } else if (this.opcode === OP.CONT) {
      if (!this.fragOpcode) throw new WsProtocolError(1002, "Unexpected continuation frame");
    } else if (this.fragOpcode) {
      throw new WsProtocolError(1002, "Expected a continuation frame");
    }
    if (!control && this.fragBytes + len > this.maxPayload) throw new WsProtocolError(1009, "Message too large");
    this.mask = masked ? this.head.slice(p, p + 4) : null;
    this.payload = new Uint8Array(len);
    this.got = 0;
    this.headLen = 0;
  }

  private endFrame(out: WsEvent[]): void {
    const data = this.payload!;
    const mask = this.mask;
    if (mask) for (let i = 0; i < data.length; i++) data[i]! ^= mask[i & 3]!;
    this.payload = null;
    this.mask = null;
    const op = this.opcode;
    if (op === OP.PING) return void out.push({ type: "ping", data });
    if (op === OP.PONG) return void out.push({ type: "pong", data });
    if (op === OP.CLOSE) return void out.push(parseClose(data));
    if (!this.fin) {
      if (op !== OP.CONT) this.fragOpcode = op;
      if (data.length) this.fragments.push(data); // empty fragments can't grow memory
      this.fragBytes += data.length;
      return;
    }
    let message = data;
    let kind = op;
    if (op === OP.CONT) {
      kind = this.fragOpcode;
      this.fragments.push(data);
      message = concat(this.fragments, this.fragBytes + data.length);
      this.fragments = [];
      this.fragBytes = 0;
      this.fragOpcode = 0;
    }
    out.push({ type: "message", data: kind === OP.TEXT ? decodeText(message) : message });
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new WsProtocolError(1007, "Invalid UTF-8");
  }
}

function parseClose(data: Uint8Array): WsEvent {
  if (data.length === 0) return { type: "close", code: 1005, reason: "" };
  if (data.length === 1) throw new WsProtocolError(1002, "Invalid close payload");
  const code = (data[0]! << 8) | data[1]!;
  if (!isValidCloseCode(code)) throw new WsProtocolError(1002, `Invalid close code ${code}`);
  return { type: "close", code, reason: decodeText(data.subarray(2)) };
}

/** In-process topic registry shared by one Node server. */
export class NodeTopics {
  private topics = new Map<string, Set<NodeWebSocket>>();
  add(topic: string, ws: NodeWebSocket): void {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(ws);
  }
  remove(topic: string, ws: NodeWebSocket): void {
    const set = this.topics.get(topic);
    if (!set) return;
    set.delete(ws);
    if (!set.size) this.topics.delete(topic);
  }
  /** Encode once, write to every subscriber except `except`. Returns the number of recipients. */
  publish(topic: string, data: WsSendable, except?: NodeWebSocket): number {
    const set = this.topics.get(topic);
    if (!set) return 0;
    const frame = encodeFrame(typeof data === "string" ? OP.TEXT : OP.BINARY, data);
    let sent = 0;
    for (const ws of set) if (ws !== except && ws.sendFrame(frame)) sent++;
    return sent;
  }
}

export interface NodeWsCallbacks {
  open(ws: NodeWebSocket): unknown;
  message(ws: NodeWebSocket, data: string | Uint8Array): unknown;
  close(ws: NodeWebSocket, code: number, reason: string): unknown;
}

/** Server side of one connection; implements the Bun ServerWebSocket subset the realtime core uses. */
export class NodeWebSocket implements BunWebSocketLike {
  data: BunWebSocketLike["data"];
  readyState = 1;
  readonly socket: Duplex;
  private readonly topics: NodeTopics;
  private readonly subs = new Set<string>();
  private readonly opts: Required<NodeWsOptions>;
  private readonly cb: NodeWsCallbacks;
  private readonly parser: FrameParser;
  private awaitingPong = false;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private closeInfo?: { code: number; reason: string };
  private reported = false;

  constructor(socket: Duplex, data: BunWebSocketLike["data"], topics: NodeTopics, opts: Required<NodeWsOptions>, cb: NodeWsCallbacks) {
    this.socket = socket;
    this.data = data;
    this.topics = topics;
    this.opts = opts;
    this.cb = cb;
    this.parser = new FrameParser({ maxPayload: opts.maxPayload, requireMask: true });
  }

  /** Start reading; `head` is any data that arrived with the handshake. */
  start(head: Uint8Array): void {
    const s = this.socket as Duplex & { setNoDelay?: (v: boolean) => void; setTimeout?: (ms: number) => void };
    s.setNoDelay?.(true);
    if (this.opts.idleTimeout > 0 && s.setTimeout) {
      // Not setTimeout(ms, cb): that callback is a one-time listener.
      s.setTimeout(this.opts.idleTimeout * 1000);
      s.on("timeout", () => this.onIdle());
    }
    s.on("data", (chunk: Uint8Array) => this.onData(chunk));
    s.on("close", () => this.onSocketClose());
    s.on("error", () => this.socket.destroy());
    void this.cb.open(this);
    if (head.length) this.onData(head);
  }

  send(data: WsSendable): number {
    if (this.readyState !== 1) return 0;
    const frame = encodeFrame(typeof data === "string" ? OP.TEXT : OP.BINARY, data);
    return this.sendFrame(frame) ? frame.length : 0;
  }

  /** Write a pre-encoded frame; drops the connection if the client is not reading. */
  sendFrame(frame: Uint8Array): boolean {
    if (this.readyState !== 1) return false;
    if (this.socket.writableLength + frame.length > this.opts.maxBufferedAmount) {
      this.terminate();
      return false;
    }
    this.socket.write(frame);
    return true;
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    if (code !== 1000 && (code < 3000 || code > 4999)) throw new RangeError(`Invalid close code ${code}; use 1000 or 3000-4999`);
    const r = encoder.encode(reason);
    if (r.length > 123) throw new RangeError("Close reason must be at most 123 bytes");
    this.sendClose(code, r);
    this.closeInfo = { code, reason };
  }

  /** Destroy the connection without a close handshake. */
  terminate(): void {
    this.readyState = 3;
    this.socket.destroy();
  }

  subscribe(topic: string): void {
    if (this.readyState > 1) return;
    this.subs.add(topic);
    this.topics.add(topic, this);
  }
  unsubscribe(topic: string): void {
    this.subs.delete(topic);
    this.topics.remove(topic, this);
  }
  isSubscribed(topic: string): boolean {
    return this.subs.has(topic);
  }
  publish(topic: string, data: WsSendable): number {
    return this.topics.publish(topic, data, this);
  }
  ping(data: WsSendable = ""): void {
    this.sendFrame(encodeFrame(OP.PING, data));
  }

  private sendClose(code: number, reason: Uint8Array = new Uint8Array()): void {
    const payload = new Uint8Array(2 + reason.length);
    payload[0] = code >>> 8;
    payload[1] = code & 0xff;
    payload.set(reason, 2);
    this.socket.write(encodeFrame(OP.CLOSE, payload));
    this.readyState = 2;
    this.closeTimer = setTimeout(() => this.socket.destroy(), this.opts.closeTimeout);
    (this.closeTimer as { unref?: () => void }).unref?.();
  }

  private onIdle(): void {
    if (this.awaitingPong || this.readyState !== 1) return this.terminate();
    this.awaitingPong = true;
    this.ping();
  }

  private onData(chunk: Uint8Array): void {
    if (this.readyState === 3) return;
    this.awaitingPong = false;
    let events: WsEvent[];
    try {
      events = this.parser.push(chunk);
    } catch (err) {
      const code = err instanceof WsProtocolError ? err.code : 1002;
      if (this.readyState === 1) {
        this.closeInfo = { code, reason: "" };
        this.sendClose(code);
      }
      this.socket.end();
      return;
    }
    for (const e of events) {
      if (e.type === "message") {
        if (this.readyState === 1) void this.cb.message(this, e.data);
      } else if (e.type === "ping") {
        this.sendFrame(encodeFrame(OP.PONG, e.data)); // backpressure-checked: ping floods can't queue unbounded pongs
      } else if (e.type === "close") {
        if (this.readyState === 1) {
          // Peer-initiated: echo the code, then close the TCP connection.
          this.closeInfo = { code: e.code, reason: e.reason };
          this.sendClose(e.code === 1005 ? 1000 : e.code, encoder.encode(e.reason));
        }
        this.socket.end();
        return;
      }
    }
  }

  private onSocketClose(): void {
    clearTimeout(this.closeTimer);
    this.readyState = 3;
    for (const t of this.subs) this.topics.remove(t, this);
    this.subs.clear();
    if (this.reported) return;
    this.reported = true;
    const info = this.closeInfo ?? { code: 1006, reason: "" };
    void this.cb.close(this, info.code, info.reason);
  }
}

interface Pending {
  upgrade?: { data: unknown; headers?: HeadersInit };
}

/**
 * The `{ upgrade, publish }` object the Node adapter passes as the second
 * argument of `app.fetch`, mirroring Bun's server so the realtime core
 * drives Node sockets through the same code path.
 */
export class NodeWsServer implements BunServerLike {
  readonly topics = new NodeTopics();
  /** Open connections (closed sockets remove themselves). */
  readonly connections = new Set<NodeWebSocket>();
  readonly options: Required<NodeWsOptions>;
  private pending = new WeakMap<Request, Pending>();
  private readonly cb: NodeWsCallbacks;

  constructor(cb: NodeWsCallbacks, opts: NodeWsOptions = {}) {
    this.cb = cb;
    this.options = {
      maxPayload: opts.maxPayload ?? 1 << 20,
      idleTimeout: opts.idleTimeout ?? 120,
      maxBufferedAmount: opts.maxBufferedAmount ?? 16 << 20,
      closeTimeout: opts.closeTimeout ?? 5000,
    };
  }

  /** Called by the realtime core (like Bun's `server.upgrade`). */
  upgrade(req: Request, opts?: { data?: unknown; headers?: HeadersInit }): boolean {
    const p = this.pending.get(req);
    if (!p || p.upgrade || !validHandshake(req.headers)) return false;
    p.upgrade = { data: opts?.data, headers: opts?.headers };
    return true;
  }

  publish(topic: string, data: WsSendable): number {
    return this.topics.publish(topic, data);
  }

  /**
   * Handle a Node `upgrade` event: run `fetch(req, this)`, then either
   * complete the handshake or write the pipeline's response and close.
   */
  async handle(req: Request, socket: Duplex, head: Uint8Array, fetch: (req: Request, server: NodeWsServer) => Promise<Response>): Promise<void> {
    const p: Pending = {};
    this.pending.set(req, p);
    socket.on("error", () => socket.destroy());
    let res: Response;
    try {
      res = await fetch(req, this);
    } catch (err) {
      console.error("[miu] adapter error:", err);
      res = new Response(null, { status: 500 });
    }
    this.pending.delete(req);
    if (socket.destroyed) return;
    if (!p.upgrade) return writeRawResponse(socket, res);
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(req.headers.get("sec-websocket-key")!)}`,
    ];
    new Headers(p.upgrade.headers).forEach((v, k) => {
      if (!HOP_BY_HOP.has(k) && k !== "set-cookie" && !k.startsWith("sec-websocket-accept")) lines.push(`${k}: ${clean(v)}`);
    });
    for (const c of new Headers(p.upgrade.headers).getSetCookie()) lines.push(`set-cookie: ${clean(c)}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    const ws = new NodeWebSocket(socket, p.upgrade.data as BunWebSocketLike["data"], this.topics, this.options, this.cb);
    this.connections.add(ws);
    socket.once("close", () => this.connections.delete(ws));
    ws.start(head);
  }
}

const HOP_BY_HOP = new Set(["connection", "upgrade", "content-length", "transfer-encoding", "keep-alive", "content-type"]);
const clean = (v: string) => v.replace(/[\r\n]/g, "");

function validHandshake(h: Headers): boolean {
  const key = h.get("sec-websocket-key");
  if (!key || !/^[A-Za-z0-9+/]{22}==$/.test(key.trim())) return false;
  if (h.get("sec-websocket-version") !== "13") return false;
  return (h.get("connection") ?? "").toLowerCase().split(/\s*,\s*/).includes("upgrade");
}

/** Write a Web Response as a raw HTTP/1.1 response on an upgrade socket, then close it. */
export async function writeRawResponse(socket: Duplex, res: Response): Promise<void> {
  const body = res.body ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
  const lines = [`HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? ""}`];
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie" && k !== "content-length" && k !== "transfer-encoding" && k !== "connection") lines.push(`${k}: ${clean(v)}`);
  });
  for (const c of res.headers.getSetCookie()) lines.push(`set-cookie: ${clean(c)}`);
  if (res.status === 426 && !res.headers.has("sec-websocket-version")) lines.push("sec-websocket-version: 13");
  lines.push(`content-length: ${body.length}`, "connection: close");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1"), body]));
}

/** Convenience for `serve()`: the `head` buffer Node passes with an upgrade. */
export type UpgradeArgs = [req: IncomingMessage, socket: Duplex, head: Buffer];
