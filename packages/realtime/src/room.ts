// Transport-independent room engine. A transport (local registry, Durable Object, tests) hands
// it sockets (`MiuSocket`: id, data, send, close) and raw frames; the engine owns players,
// reconnects, timers, validation and state diffing. Nothing here touches the network or the
// wall clock directly, so it runs the same in-process, on Workers and under a FakeClock.

import { errors, isMiuError, validate, type MiuSocket, type Schema } from "miujs";
import { systemClock, type Clock } from "./clock.ts";
import type { InitContext, Player, Role, Room, RoomStorage, RoomType } from "./define.ts";
import { diff } from "./diff.ts";
import { TokenBucket } from "./limiter.ts";
import { decode as msgpackDecode, encode as msgpackEncode } from "./msgpack.ts";
import { MemoryStorage } from "./storage.ts";

export interface JoinParams {
  name?: string;
  role?: string;
  /** Resume token from a previous `welcome`. */
  resume?: string;
  hostKey?: string;
  /** Every join query parameter (first value of each), for `onJoinRequest`. */
  params?: Record<string, string>;
  /** Wire encoding: `json` (default) or `msgpack`. */
  enc?: string;
}

export interface RoomHooks {
  /** State changed and was broadcast (used by Durable Objects to persist). */
  onChange?(): void;
  /** The last player left (after their grace period). */
  onEmpty?(): void;
  onClose?(): void;
  /** A handler failed. Default: console.error. */
  onError?(err: unknown, where: string): void;
}

export interface RoomSnapshot {
  v: 1;
  type: string;
  id: string;
  createdAt: number;
  hostKey: string;
  state: unknown;
  secret: unknown;
  /** `graceUntil` is set for players inside the reconnect grace period. */
  players: { id: string; name: string; role: Role; joinedAt: number; token: string; graceUntil?: number }[];
  /** Pending named timers (`room.schedule`). Absent in snapshots from older versions. */
  timers?: TimerEntry[];
}

export interface TimerEntry {
  id: string;
  /** Due time (ms since epoch, room clock). */
  at: number;
  name: string;
  data?: unknown;
}

export interface RoomInstanceOptions {
  id: string;
  clock?: Clock;
  storage?: RoomStorage;
  /** Passed to `init` and `secret` as `ctx.data`. */
  data?: unknown;
  hooks?: RoomHooks;
  /** Rebuild from `snapshot()` (Durable Object wake-up). Players start disconnected until re-attached. */
  restore?: RoomSnapshot;
  /**
   * The transport drives time (Durable Object alarms): the engine never sets clock timers for
   * named timers or reconnect grace; read `nextDue()` and call `runDue()` when it passes.
   * `after()` / `tick()` closures throw, since they cannot survive hibernation.
   */
  durable?: boolean;
  /** Prepended to resume tokens (shards use `s<n>.` so reconnects find their shard). */
  tokenPrefix?: string;
  /** `room.env`: Durable Object env on Workers, process env locally. Default {}. */
  env?: Record<string, unknown>;
}

export interface RoomInfo {
  type: string;
  id: string;
  players: number;
  connected: number;
  createdAt: number;
  closed: boolean;
}

interface Seat {
  player: Player;
  token: string;
  socket: MiuSocket | null;
  /** End of the reconnect grace period while disconnected. */
  graceUntil: number | null;
}

interface Conn {
  socket: MiuSocket;
  playerId: string | null;
  enc: Encoding;
  limit?: TokenBucket;
  /** Start of the current over-the-limit streak. */
  overSince?: number | null;
  lastDrop?: number;
}

interface ErrorFrame {
  code: string;
  message: string;
  fix?: string;
  details?: unknown;
}

const NAME_MAX = 32;
const MAX_PARAMS = 32;
const MAX_PARAM_LENGTH = 1024;

/** Keeps string values only, at most 32 of them, each at most 1 KiB. */
export function cleanParams(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s !== "string" || s.length > MAX_PARAM_LENGTH || k.length > 64 || k === "__proto__") continue;
    out[k] = s;
    if (++n >= MAX_PARAMS) break;
  }
  return out;
}

function joinFrameParams(f: Record<string, unknown>): Record<string, string> {
  const base = f.params && typeof f.params === "object" && !Array.isArray(f.params) ? cleanParams(f.params as Record<string, unknown>) : {};
  for (const k of ["name", "role", "hostKey"]) if (typeof f[k] === "string") base[k] = f[k] as string;
  return base;
}
const ROLES: Role[] = ["host", "player", "spectator"];

function randomId(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

/** Wire encodings a client can pick with `?enc=`. */
export type Encoding = "json" | "msgpack";
const ENCODINGS: readonly string[] = ["json", "msgpack"];

/** One outgoing frame, encoded at most once per encoding (broadcasts reuse it). */
interface Frame {
  obj: Record<string, unknown>;
  json?: string;
  mp?: Uint8Array;
}

function frame(obj: Record<string, unknown>): Frame {
  return { obj };
}

function encodeFrame(f: Frame, enc: Encoding): string | Uint8Array {
  if (enc === "msgpack") return (f.mp ??= msgpackEncode(f.obj));
  return (f.json ??= JSON.stringify(f.obj));
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as Promise<unknown>).then === "function";
}

export class RoomInstance<S = any, X = any> {
  readonly type: string;
  readonly id: string;
  readonly room: Room<S, X>;
  readonly createdAt: number;

  private def: RoomType<S, X>["def"];
  private clock: Clock;
  private hooks: RoomHooks;
  private state: S;
  private secret: X;
  /** The state as clients last saw it; patches are diffs against this. */
  private sent: S;
  private seats = new Map<string, Seat>();
  private tokens = new Map<string, string>();
  private conns = new Map<string, Conn>();
  /** Sockets that joined but have not yet received the full state. */
  private fresh = new Set<string>();
  /** Sockets closed for abuse; late frames from them are ignored. */
  private kicked = new WeakSet<MiuSocket>();
  /** Per-player view as last sent (rooms with `view`). */
  private views = new Map<string, unknown>();
  /** `after()` / `tick()` clock handles (local rooms only). */
  private timers = new Set<unknown>();
  /** Named timers in scheduling order. */
  private pending = new Map<string, TimerEntry>();
  private durable: boolean;
  private tokenPrefix: string;
  /** Clock-mode wake-up for the earliest named timer / grace deadline. */
  private wake: unknown = null;
  private wakeAt: number | null = null;
  private draining = false;
  private hostKey: string;
  private closed = false;

  constructor(roomType: RoomType<S, X>, opts: RoomInstanceOptions) {
    this.type = roomType.type;
    this.id = opts.id;
    this.def = roomType.def;
    this.clock = opts.clock ?? systemClock;
    this.hooks = opts.hooks ?? {};
    this.durable = opts.durable ?? false;
    this.tokenPrefix = opts.tokenPrefix ?? "";
    const storage = opts.storage ?? new MemoryStorage();
    const r = opts.restore;
    if (r) {
      this.createdAt = r.createdAt;
      this.hostKey = r.hostKey;
      this.state = r.state as S;
      this.secret = r.secret as X;
      for (const p of r.players) {
        const seat: Seat = { player: { id: p.id, name: p.name, role: p.role, connected: false, joinedAt: p.joinedAt }, token: p.token, socket: null, graceUntil: null };
        this.seats.set(p.id, seat);
        this.tokens.set(p.token, p.id);
        if (typeof p.graceUntil === "number") seat.graceUntil = p.graceUntil;
        else this.startGrace(seat);
      }
      for (const x of r.timers ?? []) this.pending.set(x.id, { ...x });
    } else {
      this.createdAt = this.clock.now();
      this.hostKey = randomId(16);
      const ctx: InitContext = { id: this.id, type: this.type, data: opts.data, now: this.createdAt };
      this.state = this.def.init(ctx);
      this.secret = this.def.secret ? this.def.secret(ctx) : (undefined as X);
      const issues = this.checkState();
      if (issues) {
        throw Object.assign(new Error(`Room "${this.type}" init() returned state that does not match its schema: ${issues}`), {
          code: "MIU_E_ROOM_STATE_INVALID",
        });
      }
    }
    this.sent = clone(this.state);

    const self = this;
    this.room = {
      id: this.id,
      type: this.type,
      get state() {
        return self.state;
      },
      set state(v: S) {
        self.state = v;
      },
      get secret() {
        return self.secret;
      },
      set secret(v: X) {
        self.secret = v;
      },
      get players() {
        return [...self.seats.values()].map((s) => s.player);
      },
      player: (id) => this.seats.get(id)?.player,
      broadcast: (event, data, opts) => this.broadcast(event, data, opts?.except, opts?.to),
      send: (playerId, event, data) => {
        this.flush();
        const sock = this.seats.get(playerId)?.socket;
        if (sock) this.write(sock, { t: "event", event, data });
      },
      schedule: (name, delayMs, data) => this.schedule(name, delayMs, data),
      cancel: (timerId) => this.cancelTimer(timerId),
      after: (ms, fn) => this.after(ms, fn),
      tick: (hz, fn) => this.tick(hz, fn),
      now: () => this.clock.now(),
      storage,
      env: opts.env ?? {},
      kick: (playerId, code, reason) => this.kickPlayer(playerId, code, reason),
      close: (reason) => this.close(reason),
    };
    this.rearm();
  }

  // ---- transport entry points -------------------------------------------------------------

  /** A socket opened. Joins immediately when `join` carries a name or resume token. */
  connect(socket: MiuSocket, join: JoinParams = {}): void {
    const enc = join.enc ?? "json";
    this.conns.set(socket.id, { socket, playerId: null, enc: ENCODINGS.includes(enc) ? (enc as Encoding) : "json" });
    if (!ENCODINGS.includes(enc)) {
      return this.reject(socket, { code: "MIU_E_ROOM_ENCODING_UNSUPPORTED", message: `Unknown encoding "${enc}"`, fix: "Use ?enc=json (default) or ?enc=msgpack." }, 1003);
    }
    if (this.closed) return this.reject(socket, roomClosed(), 4004);
    if (join.name !== undefined || join.resume !== undefined) this.join(socket, join);
  }

  /** Re-attach a live socket to a player after a restore (Durable Object hibernation wake-up). */
  attach(socket: MiuSocket, playerId: string, enc: Encoding = "json"): boolean {
    const seat = this.seats.get(playerId);
    if (!seat) return false;
    this.conns.set(socket.id, { socket, playerId, enc });
    seat.socket = socket;
    seat.player.connected = true;
    this.cancelGrace(seat);
    return true;
  }

  /** A frame arrived. Never throws: problems become `error` frames. */
  receive(socket: MiuSocket, raw: string | Uint8Array | ArrayBuffer): void | Promise<void> {
    if (this.kicked.has(socket)) return; // frames already in flight when we closed it
    let conn = this.conns.get(socket.id);
    if (!conn) this.conns.set(socket.id, (conn = { socket, playerId: null, enc: "json" }));
    if (!this.admit(conn)) return;
    const max = this.def.maxMessageBytes ?? 16_384;
    if (byteLength(raw, max) > max) {
      return this.kick(socket, { code: "MIU_E_ROOM_MESSAGE_TOO_LARGE", message: `Frame is larger than ${max} bytes`, fix: `Keep each frame under ${max} bytes; send big data over HTTP instead.` }, 1009);
    }
    let f: any;
    if (typeof raw !== "string") {
      if (conn.enc !== "msgpack") {
        return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: "Binary frames need the MessagePack encoding", fix: "Send JSON text frames, or connect with ?enc=msgpack to use binary MessagePack frames. See PROTOCOL.md." });
      }
      try {
        f = msgpackDecode(raw);
      } catch {
        return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: "Frame is not valid MessagePack", fix: "Send one MessagePack map per binary frame, e.g. {t: \"ping\"}." });
      }
    } else {
      try {
        f = JSON.parse(raw);
      } catch {
        return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: "Frame is not valid JSON", fix: "Send one JSON object per frame, e.g. {\"t\":\"ping\"}." });
      }
    }
    if (!f || typeof f !== "object" || Array.isArray(f) || f instanceof Uint8Array || typeof f.t !== "string") {
      return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: "Frame must be an object with a string `t`", fix: "Use one of: join, msg, ping. See PROTOCOL.md." });
    }
    const reqId = f.id;
    switch (f.t) {
      case "ping":
        this.write(socket, { t: "pong" });
        return;
      case "join":
        if (conn.playerId) return this.error(socket, { code: "MIU_E_ROOM_ALREADY_JOINED", message: "This connection already joined", fix: "Send `msg` frames; open a new connection to join as someone else." });
        if (this.closed) return this.reject(socket, roomClosed(), 4004);
        this.join(socket, { name: f.name, role: f.role, resume: f.resume, hostKey: f.hostKey, params: joinFrameParams(f) });
        return;
      case "msg":
        return this.handle(conn, f, reqId);
      default:
        return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: `Unknown frame type "${f.t}"`, fix: "Clients send join, msg or ping frames. See PROTOCOL.md." });
    }
  }

  /** A socket closed. The player keeps their seat for `reconnectMs`. */
  disconnect(socket: MiuSocket): void {
    const conn = this.conns.get(socket.id);
    this.conns.delete(socket.id);
    this.fresh.delete(socket.id);
    if (!conn?.playerId) return;
    const seat = this.seats.get(conn.playerId);
    if (!seat || seat.socket !== socket) return;
    seat.socket = null;
    seat.player.connected = false;
    this.startGrace(seat);
  }

  snapshot(): RoomSnapshot {
    return {
      v: 1,
      type: this.type,
      id: this.id,
      createdAt: this.createdAt,
      hostKey: this.hostKey,
      state: clone(this.state),
      secret: clone(this.secret),
      players: [...this.seats.values()].map((s) => {
        const { id, name, role, joinedAt } = s.player;
        const p: RoomSnapshot["players"][number] = { id, name, role, joinedAt, token: s.token };
        if (s.graceUntil !== null) p.graceUntil = s.graceUntil;
        return p;
      }),
      timers: [...this.pending.values()].map((x) => clone(x)),
    };
  }

  /** Earliest named-timer or reconnect-grace deadline, or null when nothing is pending. */
  nextDue(): number | null {
    let due: number | null = null;
    for (const x of this.pending.values()) if (due === null || x.at < due) due = x.at;
    for (const s of this.seats.values()) if (s.graceUntil !== null && (due === null || s.graceUntil < due)) due = s.graceUntil;
    return due;
  }

  /** Run every named timer and grace expiry that is due, in time order. Durable transports call this from `alarm()`. */
  async runDue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const now = this.clock.now();
        let timer: TimerEntry | null = null;
        for (const x of this.pending.values()) if (x.at <= now && (!timer || x.at < timer.at)) timer = x;
        let seat: Seat | null = null;
        for (const s of this.seats.values()) if (s.graceUntil !== null && s.graceUntil <= now && (!seat || s.graceUntil < seat.graceUntil!)) seat = s;
        if (seat && (!timer || seat.graceUntil! < timer.at)) {
          seat.graceUntil = null;
          this.removeSeat(seat);
          continue;
        }
        if (!timer) break;
        this.pending.delete(timer.id);
        const handler = this.def.timers?.[timer.name];
        if (!handler) {
          (this.hooks.onError ?? defaultOnError)(new Error(`no timer handler "${timer.name}" (declared timers: ${Object.keys(this.def.timers ?? {}).join(", ") || "none"})`), `${this.type}/${this.id} timers`);
          continue;
        }
        const data = clone(timer.data);
        const p = this.run(() => handler({ room: this.room, data, now }), `timers.${timer.name}`);
        if (p) await p;
      }
    } finally {
      this.draining = false;
    }
    this.rearm();
  }

  info(): RoomInfo {
    let connected = 0;
    for (const s of this.seats.values()) if (s.player.connected) connected++;
    return { type: this.type, id: this.id, players: this.seats.size, connected, createdAt: this.createdAt, closed: this.closed };
  }

  /** Player id for a socket, if it joined. */
  playerOf(socket: MiuSocket): string | null {
    return this.conns.get(socket.id)?.playerId ?? null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isEmpty(): boolean {
    return this.seats.size === 0;
  }

  /** Open sockets, joined or not. */
  /** Non-spectator players (they count toward `maxPlayers`). */
  get seated(): number {
    let n = 0;
    for (const s of this.seats.values()) if (s.player.role !== "spectator") n++;
    return n;
  }

  /**
   * Run server code against the room outside a client message (e.g. a shard coordinator
   * publishing an aggregate). Validated, rolled back on error and flushed like a handler.
   */
  update(fn: (room: Room<S, X>) => unknown, where = "update()"): void | Promise<void> {
    return this.run(() => fn(this.room), where);
  }

  get connections(): number {
    return this.conns.size;
  }

  /** Full view for agents and tools (state plus players). */
  describe(): { type: string; id: string; createdAt: number; state: S; players: Player[] } {
    return { type: this.type, id: this.id, createdAt: this.createdAt, state: clone(this.state), players: [...this.seats.values()].map((s) => ({ ...s.player })) };
  }

  close(reason = "room closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers.clear();
    this.pending.clear();
    if (this.wake !== null) this.clock.clearTimeout(this.wake);
    this.wake = null;
    for (const c of this.conns.values()) safeClose(c.socket, 1000, reason);
    this.conns.clear();
    this.hooks.onClose?.();
  }

  /** `room.kick()`: drop the seat for good and close its socket. */
  private kickPlayer(playerId: string, code = 4009, reason = "kicked"): boolean {
    const seat = this.seats.get(playerId);
    if (!seat || this.closed) return false;
    const sock = seat.socket;
    if (sock) {
      this.kicked.add(sock);
      this.error(sock, { code: "MIU_E_ROOM_KICKED", message: "You were removed from the room", fix: "Join another room; this seat and its resume token are gone." });
      this.conns.delete(sock.id);
      this.fresh.delete(sock.id);
      safeClose(sock, code, reason);
      seat.socket = null;
    }
    seat.player.connected = false;
    if (seat.graceUntil !== null) {
      seat.graceUntil = null;
      this.rearm();
    }
    this.removeSeat(seat);
    return true;
  }

  // ---- joining --------------------------------------------------------------------------

  private join(socket: MiuSocket, p: JoinParams): void {
    const conn = this.conns.get(socket.id)!;
    if (p.resume !== undefined) {
      const id = typeof p.resume === "string" ? this.tokens.get(p.resume) : undefined;
      const seat = id ? this.seats.get(id) : undefined;
      if (seat) {
        if (seat.socket && seat.socket !== socket) {
          const old = seat.socket;
          this.conns.delete(old.id);
          this.fresh.delete(old.id);
          safeClose(old, 4001, "replaced by a newer connection");
        }
        this.cancelGrace(seat);
        seat.socket = socket;
        seat.player.connected = true;
        conn.playerId = seat.player.id;
        this.welcome(seat, true);
        this.flush();
        return;
      }
      if (p.name === undefined) {
        return this.error(socket, {
          code: "MIU_E_ROOM_RESUME_EXPIRED",
          message: "Resume token is unknown or expired",
          fix: "Join again as a new player: send {\"t\":\"join\",\"name\":\"...\"}.",
        });
      }
    }

    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name || name.length > NAME_MAX) {
      return this.error(socket, { code: "MIU_E_ROOM_JOIN_INVALID", message: `Join needs a name of 1-${NAME_MAX} characters`, fix: "Connect with ?name=Alice or send {\"t\":\"join\",\"name\":\"Alice\"}." });
    }
    const requested = p.role ?? "player";
    if (!ROLES.includes(requested as Role)) {
      return this.error(socket, { code: "MIU_E_ROOM_JOIN_INVALID", message: `Unknown role "${String(requested)}"`, fix: "Use role host, player or spectator (or leave it out)." });
    }
    let role = requested as Role;
    const hasHost = [...this.seats.values()].some((s) => s.player.role === "host");
    if (!hasHost && role !== "spectator") role = "host";
    else if (role === "host" && p.hostKey !== this.hostKey) {
      return this.reject(socket, { code: "MIU_E_ROOM_HOST_KEY", message: "This room already has a host", fix: "Join as a player, or pass the hostKey from the host's welcome frame (?hostKey=...)." }, 4003);
    }
    const max = this.def.maxPlayers;
    if (max !== undefined && role !== "spectator") {
      let n = 0;
      for (const s of this.seats.values()) if (s.player.role !== "spectator") n++;
      if (n >= max) return this.reject(socket, { code: "MIU_E_ROOM_FULL", message: `Room is full (${max} players)`, fix: "Join another room, or join as a spectator." }, 4005);
    }

    const player: Player = { id: `p_${randomId(6)}`, name, role, connected: true, joinedAt: this.clock.now() };
    const admit = this.def.onJoinRequest;
    if (admit) {
      try {
        admit({ params: { ...(p.params ?? {}) }, player, room: this.room, now: this.clock.now() });
      } catch (err) {
        if (isMiuError(err)) return this.reject(socket, { code: err.code, message: err.message, fix: err.fix, details: err.details }, 4003);
        (this.hooks.onError ?? defaultOnError)(err, `${this.type}/${this.id} onJoinRequest`);
        return this.reject(socket, { code: "MIU_E_ROOM_JOIN_REJECTED", message: "The room refused this join", fix: "Check the server log." }, 4003);
      }
      if (!ROLES.includes(player.role)) player.role = "spectator";
    }
    const seat: Seat = { player, token: this.tokenPrefix + randomId(16), socket, graceUntil: null };
    this.seats.set(player.id, seat);
    this.tokens.set(seat.token, player.id);
    conn.playerId = player.id;
    this.welcome(seat, false);
    const onJoin = this.def.onJoin;
    if (onJoin) this.run(() => onJoin({ room: this.room, player, now: this.clock.now() }), "onJoin");
    else this.flush();
  }

  private welcome(seat: Seat, resumed: boolean): void {
    const { id, name, role } = seat.player;
    const w: Record<string, unknown> = { t: "welcome", me: { id, name, role }, room: { type: this.type, id: this.id }, resumeToken: seat.token, resumed };
    if (role === "host") w.hostKey = this.hostKey;
    if (seat.socket) {
      this.write(seat.socket, w);
      this.fresh.add(seat.socket.id);
    }
  }

  private startGrace(seat: Seat): void {
    seat.graceUntil = this.clock.now() + (this.def.reconnectMs ?? 30_000);
    this.rearm();
  }

  private cancelGrace(seat: Seat): void {
    if (seat.graceUntil === null) return;
    seat.graceUntil = null;
    this.rearm();
  }

  private removeSeat(seat: Seat): void {
    if (this.closed) return;
    this.seats.delete(seat.player.id);
    this.tokens.delete(seat.token);
    this.views.delete(seat.player.id);
    if (seat.player.role === "host") {
      const next = [...this.seats.values()].find((s) => s.player.role === "player") ?? [...this.seats.values()].find((s) => s.player.role !== "spectator");
      if (next) {
        next.player.role = "host";
        if (next.socket) this.welcome(next, true);
      }
    }
    const onLeave = this.def.onLeave;
    if (onLeave) this.run(() => onLeave({ room: this.room, player: seat.player, now: this.clock.now() }), "onLeave");
    else this.flush();
    if (this.seats.size === 0) this.hooks.onEmpty?.();
  }

  // ---- messages & handlers ---------------------------------------------------------------

  private handle(conn: Conn, f: any, reqId: unknown): void | Promise<void> {
    const socket = conn.socket;
    const seat = conn.playerId ? this.seats.get(conn.playerId) : undefined;
    if (!seat) {
      return this.error(socket, { code: "MIU_E_ROOM_NOT_JOINED", message: "Join the room before sending messages", fix: "Connect with ?name=... or send {\"t\":\"join\",\"name\":\"...\"} first." }, reqId);
    }
    const client = (this.def.client ?? {}) as Record<string, Schema>;
    const type = f.type;
    if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(client, type)) {
      const known = Object.keys(client);
      return this.error(
        socket,
        { code: "MIU_E_ROOM_UNKNOWN_MESSAGE", message: `Room "${this.type}" has no message type ${JSON.stringify(type)}`, fix: known.length ? `Use one of: ${known.join(", ")}.` : "This room accepts no client messages." },
        reqId,
      );
    }
    const checked = validate(client[type], f.data ?? {});
    if (!checked.ok) {
      return this.error(
        socket,
        {
          code: "MIU_E_ROOM_MESSAGE_INVALID",
          message: `Invalid "${type}" message: ${checked.issues.slice(0, 5).map((i) => `${i.path || "data"} ${i.message}`).join("; ")}`,
          fix: `Send data matching the "${type}" schema.`,
          details: { issues: checked.issues, schema: client[type].json },
        },
        reqId,
      );
    }
    const handler = (this.def.on as Record<string, Function> | undefined)?.[type];
    if (!handler) return;
    return this.run(() => handler({ room: this.room, sender: seat.player, msg: checked.value, now: this.clock.now() }), `on.${type}`, socket, reqId);
  }

  /** Runs user code, then validates and broadcasts the state change. Rolls back on failure. */
  private run(fn: () => unknown, where: string, socket?: MiuSocket, reqId?: unknown): void | Promise<void> {
    if (this.closed) return;
    const fail = (err: unknown) => {
      this.state = clone(this.sent);
      if (isMiuError(err)) {
        if (socket) this.error(socket, { code: err.code, message: err.message, fix: err.fix, details: err.details }, reqId);
        return;
      }
      (this.hooks.onError ?? defaultOnError)(err, `${this.type}/${this.id} ${where}`);
      if (socket) {
        this.error(socket, { code: "MIU_E_ROOM_HANDLER_FAILED", message: `The ${where} handler failed: ${err instanceof Error ? err.message : String(err)}`, fix: "Check the server log; state was rolled back." }, reqId);
      }
    };
    let result: unknown;
    try {
      result = fn();
    } catch (err) {
      fail(err);
      this.flush();
      return;
    }
    this.commit(where, socket, reqId);
    if (isThenable(result)) {
      return result.then(
        () => this.commit(where, socket, reqId),
        (err) => {
          fail(err);
          this.flush();
        },
      );
    }
  }

  private commit(where: string, socket?: MiuSocket, reqId?: unknown): void {
    if (this.closed) return;
    const issues = this.checkState();
    if (issues) {
      this.state = clone(this.sent);
      (this.hooks.onError ?? defaultOnError)(new Error(`state invalid: ${issues}`), `${this.type}/${this.id} ${where}`);
      if (socket) {
        this.error(socket, { code: "MIU_E_ROOM_STATE_INVALID", message: `The ${where} handler left state that does not match the schema: ${issues}`, fix: "Fix the handler or the room's state schema; the change was rolled back." }, reqId);
      }
    }
    this.flush();
  }

  private checkState(): string | null {
    const r = validate(this.def.state, this.state);
    return r.ok ? null : r.issues.slice(0, 5).map((i) => `${i.path || "state"} ${i.message}`).join("; ");
  }

  /** Send pending state changes: a patch to everyone, or full state to sockets that just joined. */
  private flush(): void {
    if (this.closed) return;
    const ops = diff(this.sent, this.state);
    if (this.def.view) return this.flushViews(ops.length > 0);
    if (ops.length) {
      this.sent = clone(this.state);
      const patch = frame({ t: "patch", ops });
      for (const seat of this.seats.values()) {
        if (seat.socket && !this.fresh.has(seat.socket.id)) this.deliver(seat.socket, patch);
      }
      this.hooks.onChange?.();
    }
    if (this.fresh.size) {
      const full = frame({ t: "state", state: this.sent });
      for (const c of this.conns.values()) if (this.fresh.has(c.socket.id)) this.deliver(c.socket, full);
      this.fresh.clear();
    }
  }

  /** Interest management: each player gets `view(state, player)`, diffed against what they last saw. */
  private flushViews(changed: boolean): void {
    if (changed) this.sent = clone(this.state);
    if (changed || this.fresh.size) {
      for (const seat of this.seats.values()) {
        const sock = seat.socket;
        if (!sock) continue;
        const isFresh = this.fresh.has(sock.id);
        if (!changed && !isFresh) continue;
        let v: unknown;
        try {
          v = clone(this.def.view!(this.sent, seat.player));
        } catch (err) {
          (this.hooks.onError ?? defaultOnError)(err, `${this.type}/${this.id} view(${seat.player.id})`);
          continue;
        }
        if (isFresh) this.write(sock, { t: "state", state: v });
        else {
          const ops = diff(this.views.get(seat.player.id), v);
          if (ops.length) this.write(sock, { t: "patch", ops });
        }
        this.views.set(seat.player.id, v);
      }
      this.fresh.clear();
    }
    if (changed) this.hooks.onChange?.();
  }

  private broadcast(event: string, data: unknown, except?: string, to?: (player: Player) => boolean): void {
    this.flush();
    const msg = frame({ t: "event", event, data });
    for (const seat of this.seats.values()) {
      if (!seat.socket || seat.player.id === except) continue;
      if (to && !to(seat.player)) continue;
      this.deliver(seat.socket, msg);
    }
  }

  // ---- timers ----------------------------------------------------------------------------

  private schedule(name: string, delayMs: number, data?: unknown): string {
    const declared = Object.keys(this.def.timers ?? {});
    if (!declared.includes(name)) {
      throw errors.custom({
        code: "MIU_E_ROOM_TIMER_UNKNOWN",
        status: 500,
        message: `Room "${this.type}" has no timer handler "${name}"`,
        fix: declared.length ? `Use one of: ${declared.join(", ")}, or add ${name} to defineRoom({ timers: { ... } }).` : `Declare it: defineRoom("${this.type}", { timers: { ${name}: ({ room, data }) => { ... } } }).`,
      });
    }
    const id = `t_${randomId(6)}`;
    if (this.closed) return id;
    const at = this.clock.now() + Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
    const entry: TimerEntry = { id, at, name };
    if (data !== undefined) entry.data = clone(data);
    this.pending.set(id, entry);
    this.rearm();
    return id;
  }

  private cancelTimer(id: string): boolean {
    const had = this.pending.delete(id);
    if (had) this.rearm();
    return had;
  }

  /** Clock mode: keep one clock timeout at the earliest due time. Durable mode: the transport polls `nextDue()`. */
  private rearm(): void {
    if (this.durable || this.draining || this.closed) return;
    const due = this.nextDue();
    if (due === this.wakeAt) return;
    if (this.wake !== null) this.clock.clearTimeout(this.wake);
    this.wake = null;
    this.wakeAt = due;
    if (due === null) return;
    this.wake = this.clock.setTimeout(() => {
      this.wake = null;
      this.wakeAt = null;
      this.runDue().catch((err) => (this.hooks.onError ?? defaultOnError)(err, `${this.type}/${this.id} timers`));
    }, due - this.clock.now());
  }

  private notDurable(what: string): never {
    throw errors.custom({
      code: "MIU_E_ROOM_TIMER_NOT_DURABLE",
      status: 500,
      message: `room.${what}() closures cannot survive Durable Object hibernation`,
      fix: `Declare a named timer and call room.schedule(name, delayMs, data): defineRoom("${this.type}", { timers: { reveal: ({ room, data }) => { ... } } }). For a loop, re-schedule from inside the handler.`,
    });
  }

  private after(ms: number, fn: () => unknown): () => void {
    if (this.durable) this.notDurable("after");
    if (this.closed) return () => {};
    const h = this.clock.setTimeout(() => {
      this.timers.delete(h);
      this.run(fn, "after()");
    }, ms);
    this.timers.add(h);
    return () => {
      this.clock.clearTimeout(h);
      this.timers.delete(h);
    };
  }

  private tick(hz: number, fn: (info: { dt: number; now: number }) => unknown): () => void {
    if (this.durable) this.notDurable("tick");
    const interval = 1000 / hz;
    let last = this.clock.now();
    let h: unknown = null;
    let stopped = false;
    const schedule = () => {
      if (this.closed || stopped) return;
      h = this.clock.setTimeout(() => {
        this.timers.delete(h);
        const now = this.clock.now();
        const dt = now - last;
        last = now;
        this.run(() => fn({ dt, now }), "tick()");
        schedule();
      }, interval);
      this.timers.add(h);
    };
    schedule();
    return () => {
      stopped = true;
      if (h !== null) {
        this.clock.clearTimeout(h);
        this.timers.delete(h);
      }
    };
  }

  // ---- output ----------------------------------------------------------------------------

  private write(socket: MiuSocket, obj: Record<string, unknown>): void {
    this.deliver(socket, frame(obj));
  }

  /** Send a frame in the socket's negotiated encoding. */
  private deliver(socket: MiuSocket, f: Frame): void {
    safeSend(socket, encodeFrame(f, this.conns.get(socket.id)?.enc ?? "json"));
  }

  private error(socket: MiuSocket, e: ErrorFrame, reqId?: unknown): void {
    const f: Record<string, unknown> = { t: "error", code: e.code, message: e.message };
    if (e.fix) f.fix = e.fix;
    if (e.details !== undefined) f.details = e.details;
    if (reqId !== undefined) f.id = reqId;
    this.write(socket, f);
  }

  private reject(socket: MiuSocket, e: ErrorFrame, code: number): void {
    this.error(socket, e);
    this.conns.delete(socket.id);
    safeClose(socket, code, e.code);
  }

  /** Close an abusive connection. A joined player keeps their seat for the grace period. */
  private kick(socket: MiuSocket, e: ErrorFrame, code: number): void {
    this.kicked.add(socket);
    this.error(socket, e);
    this.disconnect(socket);
    safeClose(socket, code, e.code);
  }

  /** Per-connection rate limit. False when the frame must be dropped. */
  private admit(conn: Conn): boolean {
    const rl = this.def.rateLimit;
    if (rl === false) return true;
    const now = this.clock.now();
    const perSecond = rl?.perSecond ?? 30;
    const burst = rl?.burst ?? perSecond * 2;
    conn.limit ??= new TokenBucket(perSecond, burst, now);
    if (conn.overSince != null && now - (conn.lastDrop ?? now) >= 1000) conn.overSince = null;
    if (conn.limit.take(now)) return true;
    conn.lastDrop = now;
    const e: ErrorFrame = { code: "MIU_E_ROOM_RATE_LIMITED", message: "Too many messages; this one was dropped", fix: `Send at most ${perSecond} messages per second (bursts up to ${burst}). Batch inputs or throttle the client.` };
    if (conn.overSince == null) {
      conn.overSince = now;
      this.error(conn.socket, e);
    } else if (now - conn.overSince >= (rl?.kickAfterMs ?? 3_000)) {
      this.kick(conn.socket, { ...e, message: "Disconnected for sending too many messages" }, 4008);
    }
    return false;
  }
}

const utf8 = new TextEncoder();

/** Size of a frame in bytes (exact only when it might exceed `max`). */
function byteLength(raw: string | Uint8Array | ArrayBuffer, max: number): number {
  if (typeof raw !== "string") return raw.byteLength;
  if (raw.length * 3 <= max) return raw.length;
  return utf8.encode(raw).length;
}

function roomClosed(): ErrorFrame {
  return { code: "MIU_E_ROOM_CLOSED", message: "This room has been closed", fix: "Join or create another room." };
}

function safeSend(socket: MiuSocket, data: string | Uint8Array): void {
  try {
    socket.send(data);
  } catch {
    // Socket already gone; its close event will clean up.
  }
}

function safeClose(socket: MiuSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}

function defaultOnError(err: unknown, where: string): void {
  console.error(`[miujs/realtime] ${where} failed:`, err);
}

/** Create a room engine for a room type. Transports call connect/receive/disconnect. */
export function createRoomInstance<S, X>(roomType: RoomType<S, X, any>, opts: RoomInstanceOptions): RoomInstance<S, X> {
  return new RoomInstance(roomType, opts);
}
