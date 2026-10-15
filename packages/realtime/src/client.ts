// Framework-agnostic browser/server client for MiuJS rooms. No dependencies besides the
// shared patch code; works anywhere with a WebSocket (browsers, Bun, Deno, Node 22+).
//
//   import { connect } from "@miujs/realtime/client";
//   const room = connect("wss://example.com/rooms/quiz/123456", { name: "Ann" });
//   room.on("state", (s) => render(s));
//   room.send("answer", { choice: 2 });

import { applyPatch, type PatchOp } from "./diff.ts";
import { decode as msgpackDecode, encode as msgpackEncode } from "./msgpack.ts";

export interface Me {
  id: string;
  name: string;
  role: "host" | "player" | "spectator";
}

export interface ConnectOptions {
  /** Display name. Required unless you resume. */
  name?: string;
  role?: "host" | "player" | "spectator";
  /** Lets a second connection join as host (from the host's `welcome`). */
  hostKey?: string;
  /** Resume token from an earlier session (e.g. saved in sessionStorage). */
  resume?: string;
  /** WebSocket constructor to use. Default: the global `WebSocket`. */
  WebSocket?: new (url: string) => WebSocket;
  /** Auto-reconnect with the resume token. Default on. */
  reconnect?: boolean | { minDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  /** Extra join query parameters, seen by the room's `onJoinRequest` (e.g. a ticket). Cannot replace name, role, hostKey, resume or enc. */
  params?: Record<string, string>;
  /** Wire encoding. `msgpack` sends `?enc=msgpack` and uses binary MessagePack frames. Default `json`. */
  encoding?: "json" | "msgpack";
}

export interface ErrorFrame {
  t: "error";
  code: string;
  message: string;
  fix?: string;
  details?: unknown;
  id?: unknown;
}

export interface RoomClient<S = any> {
  /** Latest server state (undefined until the first `state` frame). */
  readonly state: S | undefined;
  readonly me: Me | null;
  /** Present when you are the host: lets another device join as host. */
  readonly hostKey: string | undefined;
  readonly resumeToken: string | null;
  readonly connected: boolean;
  /** The current raw WebSocket (for debugging). */
  readonly socket: WebSocket | null;
  /** Resolves once joined and the first full state arrived. */
  readonly ready: Promise<RoomClient<S>>;
  /**
   * Listen for a server event (`room.broadcast` / `room.send`) or a built-in one:
   * `state` (state, ops), `welcome`, `error`, `open`, `close` ({ code, reason, willReconnect }),
   * `reconnecting` ({ attempt, delayMs }), `reconnected`. Returns an unsubscribe function.
   */
  on(event: string, fn: (data: any, extra?: any) => void): () => void;
  /** Send a typed client message. Queued while reconnecting. */
  send(type: string, data?: unknown): void;
  /** Leave for good (no reconnect). */
  close(): void;
}

const RESERVED = new Set(["name", "role", "hostKey", "resume", "enc"]);

/** Close codes after which reconnecting would not help. */
const TERMINAL = new Set([1000, 1003, 1009, 4001, 4003, 4004, 4005, 4008]);

export function connect<S = any>(url: string, opts: ConnectOptions = {}): RoomClient<S> {
  const WS = opts.WebSocket ?? (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!WS) throw new Error("No WebSocket implementation found; pass { WebSocket } to connect().");
  const rc = opts.reconnect === false ? null : { minDelayMs: 250, maxDelayMs: 5_000, maxAttempts: Infinity, ...(typeof opts.reconnect === "object" ? opts.reconnect : {}) };

  const listeners = new Map<string, Set<(data: any, extra?: any) => void>>();
  const packed = opts.encoding === "msgpack";
  const queue: (string | Uint8Array<ArrayBuffer>)[] = [];
  let state: S | undefined;
  let me: Me | null = null;
  let hostKey = opts.hostKey;
  let resumeToken: string | null = opts.resume ?? null;
  let ws: WebSocket | null = null;
  let joined = false;
  let everJoined = false;
  let welcomedSock: WebSocket | null = null;
  let closedByUser = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady!: (c: RoomClient<S>) => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<RoomClient<S>>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => {});

  const emit = (event: string, data?: unknown, extra?: unknown) => {
    for (const fn of [...(listeners.get(event) ?? [])]) {
      try {
        fn(data, extra);
      } catch (err) {
        console.error(`[miujs/realtime] "${event}" listener failed:`, err);
      }
    }
  };

  const buildUrl = () => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.params ?? {})) if (!RESERVED.has(k)) u.searchParams.set(k, v);
    if (opts.name !== undefined) u.searchParams.set("name", opts.name);
    if (opts.role) u.searchParams.set("role", opts.role);
    if (hostKey) u.searchParams.set("hostKey", hostKey);
    if (resumeToken) u.searchParams.set("resume", resumeToken);
    if (packed) u.searchParams.set("enc", "msgpack");
    return u.toString();
  };

  const open = () => {
    const sock = new WS(buildUrl());
    if (packed) sock.binaryType = "arraybuffer";
    ws = sock;
    joined = false;
    sock.addEventListener("open", () => emit("open"));
    sock.addEventListener("message", (e: MessageEvent) => {
      let f: any;
      try {
        f = typeof e.data === "string" ? JSON.parse(e.data) : msgpackDecode(e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data as ArrayBuffer));
      } catch {
        return;
      }
      switch (f.t) {
        case "welcome": {
          me = f.me;
          resumeToken = f.resumeToken;
          if (f.hostKey) hostKey = f.hostKey;
          // A welcome on a new socket after an earlier join is a reconnect (a repeat welcome on
          // the same socket just means our role changed, e.g. promoted to host).
          const isReconnect = everJoined && welcomedSock !== sock;
          welcomedSock = sock;
          joined = everJoined = true;
          attempt = 0;
          emit("welcome", f);
          if (isReconnect) emit("reconnected", f);
          while (queue.length && ws === sock) sock.send(queue.shift()!);
          break;
        }
        case "state":
          state = f.state;
          emit("state", state, []);
          resolveReady(client);
          break;
        case "patch":
          state = applyPatch<S>(state ?? {}, f.ops as PatchOp[]);
          emit("state", state, f.ops);
          break;
        case "event":
          emit(f.event, f.data);
          break;
        case "error":
          emit("error", f as ErrorFrame);
          break;
      }
    });
    sock.addEventListener("close", (e: CloseEvent) => {
      if (ws !== sock) return;
      joined = false;
      const willReconnect = !!rc && !closedByUser && !TERMINAL.has(e.code) && attempt < rc.maxAttempts;
      emit("close", { code: e.code, reason: e.reason, willReconnect });
      if (!willReconnect) {
        ws = null;
        rejectReady(new Error(`Room connection closed (${e.code} ${e.reason})`));
        return;
      }
      attempt++;
      const delayMs = Math.min(rc!.maxDelayMs, rc!.minDelayMs * 2 ** (attempt - 1));
      emit("reconnecting", { attempt, delayMs });
      timer = setTimeout(() => {
        timer = null;
        if (!closedByUser) open();
      }, delayMs);
    });
  };

  const client: RoomClient<S> = {
    get state() {
      return state;
    },
    get me() {
      return me;
    },
    get hostKey() {
      return hostKey;
    },
    get resumeToken() {
      return resumeToken;
    },
    get connected() {
      return joined && !!ws && ws.readyState === 1;
    },
    get socket() {
      return ws;
    },
    ready,
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    send(type, data = {}) {
      const f = { t: "msg", type, data };
      const msg = packed ? msgpackEncode(f) : JSON.stringify(f);
      if (ws && joined && ws.readyState === 1) ws.send(msg);
      else queue.push(msg);
    },
    close() {
      closedByUser = true;
      if (timer) clearTimeout(timer);
      if (ws && ws.readyState <= 1) ws.close(1000, "bye");
      else emit("close", { code: 1000, reason: "bye", willReconnect: false });
    },
  };

  open();
  return client;
}
