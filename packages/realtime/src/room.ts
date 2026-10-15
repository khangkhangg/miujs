// Transport-independent room engine. A transport (local registry, Durable Object, tests) hands
// it sockets (`MiuSocket`: id, data, send, close) and raw frames; the engine owns players,
// reconnects, timers, validation and state diffing. Nothing here touches the network or the
// wall clock directly, so it runs the same in-process, on Workers and under a FakeClock.

import { isMiuError, validate, type MiuSocket, type Schema } from "miujs";
import { systemClock, type Clock } from "./clock.ts";
import type { InitContext, Player, Role, Room, RoomStorage, RoomType } from "./define.ts";
import { diff } from "./diff.ts";
import { MemoryStorage } from "./storage.ts";

export interface JoinParams {
  name?: string;
  role?: string;
  /** Resume token from a previous `welcome`. */
  resume?: string;
  hostKey?: string;
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
  players: { id: string; name: string; role: Role; joinedAt: number; token: string }[];
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
  grace: unknown;
}

interface Conn {
  socket: MiuSocket;
  playerId: string | null;
}

interface ErrorFrame {
  code: string;
  message: string;
  fix?: string;
  details?: unknown;
}

const NAME_MAX = 32;
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

function frame(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
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
  private timers = new Set<unknown>();
  private hostKey: string;
  private closed = false;

  constructor(roomType: RoomType<S, X>, opts: RoomInstanceOptions) {
    this.type = roomType.type;
    this.id = opts.id;
    this.def = roomType.def;
    this.clock = opts.clock ?? systemClock;
    this.hooks = opts.hooks ?? {};
    const storage = opts.storage ?? new MemoryStorage();
    const r = opts.restore;
    if (r) {
      this.createdAt = r.createdAt;
      this.hostKey = r.hostKey;
      this.state = r.state as S;
      this.secret = r.secret as X;
      for (const p of r.players) {
        const seat: Seat = { player: { id: p.id, name: p.name, role: p.role, connected: false, joinedAt: p.joinedAt }, token: p.token, socket: null, grace: null };
        this.seats.set(p.id, seat);
        this.tokens.set(p.token, p.id);
        this.startGrace(seat);
      }
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
      broadcast: (event, data, opts) => this.broadcast(event, data, opts?.except),
      send: (playerId, event, data) => {
        this.flush();
        const sock = this.seats.get(playerId)?.socket;
        if (sock) this.write(sock, { t: "event", event, data });
      },
      after: (ms, fn) => this.after(ms, fn),
      tick: (hz, fn) => this.tick(hz, fn),
      now: () => this.clock.now(),
      storage,
      close: (reason) => this.close(reason),
    };
  }

  // ---- transport entry points -------------------------------------------------------------

  /** A socket opened. Joins immediately when `join` carries a name or resume token. */
  connect(socket: MiuSocket, join: JoinParams = {}): void {
    this.conns.set(socket.id, { socket, playerId: null });
    if (this.closed) return this.reject(socket, roomClosed(), 4004);
    if (join.name !== undefined || join.resume !== undefined) this.join(socket, join);
  }

  /** Re-attach a live socket to a player after a restore (Durable Object hibernation wake-up). */
  attach(socket: MiuSocket, playerId: string): boolean {
    const seat = this.seats.get(playerId);
    if (!seat) return false;
    this.conns.set(socket.id, { socket, playerId });
    seat.socket = socket;
    seat.player.connected = true;
    this.cancelGrace(seat);
    return true;
  }

  /** A frame arrived. Never throws: problems become `error` frames. */
  receive(socket: MiuSocket, raw: string | Uint8Array | ArrayBuffer): void | Promise<void> {
    let conn = this.conns.get(socket.id);
    if (!conn) this.conns.set(socket.id, (conn = { socket, playerId: null }));
    if (typeof raw !== "string") {
      return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: "Binary frames are not supported", fix: "Send JSON text frames, e.g. {\"t\":\"msg\",\"type\":\"answer\",\"data\":{...}}. See PROTOCOL.md." });
    }
    let f: any;
    try {
      f = JSON.parse(raw);
    } catch {
      return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: "Frame is not valid JSON", fix: "Send one JSON object per frame, e.g. {\"t\":\"ping\"}." });
    }
    if (!f || typeof f !== "object" || Array.isArray(f) || typeof f.t !== "string") {
      return this.error(socket, { code: "MIU_E_ROOM_BAD_FRAME", message: "Frame must be a JSON object with a string `t`", fix: "Use one of: join, msg, ping. See PROTOCOL.md." });
    }
    const reqId = f.id;
    switch (f.t) {
      case "ping":
        this.write(socket, { t: "pong" });
        return;
      case "join":
        if (conn.playerId) return this.error(socket, { code: "MIU_E_ROOM_ALREADY_JOINED", message: "This connection already joined", fix: "Send `msg` frames; open a new connection to join as someone else." });
        if (this.closed) return this.reject(socket, roomClosed(), 4004);
        this.join(socket, { name: f.name, role: f.role, resume: f.resume, hostKey: f.hostKey });
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
      players: [...this.seats.values()].map((s) => ({ ...s.player, token: s.token })).map(({ connected: _c, ...p }) => p),
    };
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
    for (const s of this.seats.values()) if (s.grace) this.clock.clearTimeout(s.grace);
    for (const c of this.conns.values()) safeClose(c.socket, 1000, reason);
    this.conns.clear();
    this.hooks.onClose?.();
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
    const seat: Seat = { player, token: randomId(16), socket, grace: null };
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
    this.cancelGrace(seat);
    seat.grace = this.clock.setTimeout(() => {
      seat.grace = null;
      this.removeSeat(seat);
    }, this.def.reconnectMs ?? 30_000);
  }

  private cancelGrace(seat: Seat): void {
    if (seat.grace) this.clock.clearTimeout(seat.grace);
    seat.grace = null;
  }

  private removeSeat(seat: Seat): void {
    if (this.closed) return;
    this.seats.delete(seat.player.id);
    this.tokens.delete(seat.token);
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
    if (ops.length) {
      this.sent = clone(this.state);
      const patch = frame({ t: "patch", ops });
      for (const seat of this.seats.values()) {
        if (seat.socket && !this.fresh.has(seat.socket.id)) safeSend(seat.socket, patch);
      }
      this.hooks.onChange?.();
    }
    if (this.fresh.size) {
      const full = frame({ t: "state", state: this.sent });
      for (const c of this.conns.values()) if (this.fresh.has(c.socket.id)) safeSend(c.socket, full);
      this.fresh.clear();
    }
  }

  private broadcast(event: string, data: unknown, except?: string): void {
    this.flush();
    const msg = frame({ t: "event", event, data });
    for (const seat of this.seats.values()) if (seat.socket && seat.player.id !== except) safeSend(seat.socket, msg);
  }

  // ---- timers ----------------------------------------------------------------------------

  private after(ms: number, fn: () => unknown): () => void {
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
    safeSend(socket, frame(obj));
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
}

function roomClosed(): ErrorFrame {
  return { code: "MIU_E_ROOM_CLOSED", message: "This room has been closed", fix: "Join or create another room." };
}

function safeSend(socket: MiuSocket, data: string): void {
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
