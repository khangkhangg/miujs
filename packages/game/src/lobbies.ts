// Private matches through lobbies.
//
//   const party = lobbies({ rooms: realtime, room: "arena", minPlayers: 2, maxPlayers: 8 });
//
// Routes (auth required):
//   POST /lobbies                   → { lobby }            (you are the host; lobby.code is the 6-digit join code)
//   POST /lobbies/join  { code }    → { lobby }
//   POST /lobbies/:id/ready { ready } → { lobby }
//   POST /lobbies/:id/leave         → { left }
//   POST /lobbies/:id/start         → { lobby, ticket }    (host only; everyone else ready)
//   GET  /lobbies/:id               → { lobby, ticket? }   (members only; ticket once started)
//
// Codes use realtime's code store (memory locally, KV on Workers with `codes`). Lobby state lives
// in memory locally and in a Durable Object per lobby ("lobby:<id>", binding MIU_LOBBY) on
// Workers. Lobby matches are unrated: results update stats and achievements only.

import { definePlugin, errors, isMiuError, route, t, type CloudflareNeeds, type Context, type Env } from "miujs";
import type { DatabaseSource } from "@miujs/db";
import { CODE_RE, KvCodeStore, MemoryCodeStore, allocateCode, systemClock, type Clock, type CodeStore, type KvLike } from "@miujs/realtime";
import type { AchievementSet } from "./achievements.ts";
import type { CfWebSocketLike, NamespaceLike } from "./cloudflare.ts";
import { defaultDatabase, isD1Ref } from "./db.ts";
import { gameErrors } from "./errors.ts";
import { ticketGate } from "./gate.ts";
import { LobbyCore, lobbyId, type LobbyInit, type LobbySnapshot, type LobbyView } from "./lobby.ts";
import type { MatchSpec, RoomRef } from "./queue.ts";
import { roomsPathOf, type RoomsLike } from "./matchmaker.ts";
import { registerResultSink, type GameRoomData } from "./room.ts";
import { gameSecretFor, issueTicket } from "./sign.ts";
import { storeFor } from "./store.ts";

export interface LobbiesOptions {
  rooms: RoomsLike;
  /** Room type every lobby starts. */
  room: string;
  minPlayers?: number;
  maxPlayers?: number;
  /** Teams members are spread over (join order). Default 2. */
  teams?: number;
  secret?: string;
  database?: DatabaseSource;
  achievements?: AchievementSet;
  /** KV binding for join codes on Workers (else per-isolate memory). */
  codes?: string;
  /** Code (and local lobby) lifetime. Default 6 hours. */
  codeTtlMs?: number;
  ticketTtlMs?: number;
  path?: string;
  binding?: string;
  className?: string;
  clock?: Clock;
}

export type LobbyRequest =
  | { op: "create"; init: LobbyInit }
  | { op: "join"; userId: string; name: string }
  | { op: "leave"; userId: string }
  | { op: "ready"; userId: string; ready: boolean }
  | { op: "start"; userId: string }
  | { op: "started"; room: RoomRef }
  | { op: "startFailed" }
  | { op: "view"; userId: string };

export interface LobbyReply {
  lobby: LobbyView;
  spec?: MatchSpec;
  left?: boolean;
}

/** Run one lobby operation (shared by the local host and the Durable Object). */
export function execLobby(core: LobbyCore | null, req: LobbyRequest, now: number): { core: LobbyCore; reply: LobbyReply } {
  if (req.op === "create") {
    const c = new LobbyCore(req.init);
    return { core: c, reply: { lobby: c.view() } };
  }
  if (!core) throw gameErrors.lobbyNotFound();
  switch (req.op) {
    case "join":
      core.join(req.userId, req.name, now);
      break;
    case "leave":
      return { core, reply: { lobby: core.view(), left: core.leave(req.userId) } };
    case "ready":
      core.ready(req.userId, req.ready);
      break;
    case "start":
      return { core, reply: { lobby: core.view(), spec: core.start(req.userId, now) } };
    case "started":
      core.started(req.room);
      break;
    case "startFailed":
      core.startFailed();
      break;
    case "view":
      if (!core.isMember(req.userId)) throw gameErrors.lobbyNotMember();
      break;
  }
  return { core, reply: { lobby: core.view() } };
}

interface LobbyHost {
  exec(id: string, req: LobbyRequest): Promise<LobbyReply>;
}

const INTERNAL = Symbol.for("miujs.game.lobbies");

export function lobbies(opts: LobbiesOptions) {
  const clock = opts.clock ?? systemClock;
  const prefix = (opts.path ?? "/lobbies").replace(/\/+$/, "");
  const binding = opts.binding ?? "MIU_LOBBY";
  const className = opts.className ?? "MiuLobbies";
  const codeTtl = opts.codeTtlMs ?? 6 * 3_600_000;
  const ticketTtl = opts.ticketTtlMs ?? 60_000;
  const minPlayers = opts.minPlayers ?? 2;
  const maxPlayers = opts.maxPlayers ?? 8;
  const teams = opts.teams ?? 2;
  const source = opts.database ?? defaultDatabase();
  if (!opts.rooms.registry.has(opts.room)) {
    throw gameErrors.roomConfig(`lobbies() uses room type "${opts.room}", which the rooms plugin does not host`, `Add it: rooms({ rooms: [${opts.room}] }), and pass that plugin as lobbies({ rooms }).`);
  }
  if (!(minPlayers >= 1 && maxPlayers >= minPlayers && teams >= 1)) {
    throw gameErrors.roomConfig("lobbies(): need 1 <= minPlayers <= maxPlayers and teams >= 1", "e.g. lobbies({ minPlayers: 2, maxPlayers: 8, teams: 2 }).");
  }
  const roomsPath = roomsPathOf(opts.rooms);
  let lastEnv: Env = {};
  let secret: string | null = null;
  const key = () => (secret ??= gameSecretFor(opts.secret, lastEnv));
  const store = (env?: Env) => storeFor(source, env ?? lastEnv, { clock, achievements: opts.achievements });
  const unregisterSink = registerResultSink(opts.room, (m, r, env) => store(env).reportResult(m, r));

  const memoryCodes = new MemoryCodeStore(clock);
  const codeStore = (ctx: Context): CodeStore => {
    const kv = opts.codes && ctx.runtime === "workerd" ? (ctx.env?.[opts.codes] as KvLike | undefined) : undefined;
    return kv && typeof kv.put === "function" ? new KvCodeStore(kv, "miu:lobby:") : memoryCodes;
  };

  // Local lobbies in creation order (a Map keeps insertion order and set() on an existing key does
  // not move it), so expiry stops at the first lobby that is still young.
  const local = new Map<string, LobbyCore>();
  const forget = (id: string, core: LobbyCore) => {
    local.delete(id);
    memoryCodes.delete(core.view().code);
  };
  const localHost: LobbyHost = {
    async exec(id, req) {
      const now = clock.now();
      for (const [k, l] of local) {
        if (now - l.createdAt < codeTtl) break;
        forget(k, l);
      }
      const { core, reply } = execLobby(local.get(id) ?? null, req, now);
      // A lobby everyone left is gone for good (nobody can rejoin a lobby with no members to start it).
      if (core.view().members.length === 0) forget(id, core);
      else local.set(id, core);
      return reply;
    },
  };
  const host = (ctx: Context): LobbyHost => {
    const ns = ctx.runtime === "workerd" ? (ctx.env?.[binding] as NamespaceLike | undefined) : undefined;
    if (!ns || typeof ns.idFromName !== "function") return localHost;
    return {
      async exec(id, req) {
        const res = await ns.get(ns.idFromName(`lobby:${id}`)).fetch(new Request("https://miu-lobby/_miu/lobby/exec", { method: "POST", body: JSON.stringify(req) }));
        const json = (await res.json()) as { ok?: LobbyReply; error?: { code: string; message: string; fix?: string } };
        if (json.error) throw errors.custom({ code: json.error.code, status: res.status, message: json.error.message, fix: json.error.fix });
        return json.ok!;
      },
    };
  };

  /** The member's ticket for a started lobby. */
  async function ticketFor(lobby: LobbyView, userId: string): Promise<string | undefined> {
    if (lobby.status !== "started" || !lobby.room || !lobby.matchId) return undefined;
    const m = lobby.members.find((x) => x.userId === userId);
    if (!m) return undefined;
    return issueTicket(key(), { userId, name: m.name, roomType: lobby.room.type, roomId: lobby.room.id, matchId: lobby.matchId, team: m.team }, clock.now(), ticketTtl);
  }

  const nameOf = (user: { id: string; name?: unknown }) => (typeof user.name === "string" && user.name ? user.name.slice(0, 32) : user.id);
  const idParam = t.object({ id: t.string({ pattern: /^l[0-9a-f]{16}$/ }) });

  const routes = [
    route.post(prefix, {
      name: "lobby_create",
      summary: "Create a private lobby; share lobby.code so friends can join",
      tags: ["game"],
      auth: "required",
      mcp: false,
      handler: async (ctx) => {
        const id = lobbyId();
        const code = await allocateCode(codeStore(ctx as unknown as Context), { type: "lobby", id }, codeTtl);
        const init: LobbyInit = { id, code, roomType: opts.room, hostId: ctx.user.id, hostName: nameOf(ctx.user), minPlayers, maxPlayers, teams, now: clock.now() };
        return host(ctx as unknown as Context).exec(id, { op: "create", init });
      },
    }),
    route.post(`${prefix}/join`, {
      name: "lobby_join",
      summary: "Join a lobby with its 6-digit code",
      tags: ["game"],
      auth: "required",
      mcp: false,
      body: t.object({ code: t.string({ pattern: /^\d{6}$/ }) }),
      handler: async (ctx) => {
        const found = CODE_RE.test(ctx.body.code) ? await codeStore(ctx as unknown as Context).get(ctx.body.code) : null;
        if (!found || found.type !== "lobby") throw gameErrors.lobbyNotFound();
        return host(ctx as unknown as Context).exec(found.id, { op: "join", userId: ctx.user.id, name: nameOf(ctx.user) });
      },
    }),
    route.get(`${prefix}/:id`, {
      name: "lobby_get",
      summary: "A lobby's members and status; members get their room ticket once it started",
      tags: ["game"],
      auth: "required",
      mcp: false,
      params: idParam,
      handler: async (ctx) => {
        const r = await host(ctx as unknown as Context).exec(ctx.params.id, { op: "view", userId: ctx.user.id });
        const ticket = await ticketFor(r.lobby, ctx.user.id);
        return ticket ? { lobby: r.lobby, ticket } : { lobby: r.lobby };
      },
    }),
    route.post(`${prefix}/:id/ready`, {
      name: "lobby_ready",
      summary: "Mark yourself ready (or not) in a lobby",
      tags: ["game"],
      auth: "required",
      mcp: false,
      params: idParam,
      body: t.object({ ready: t.boolean() }),
      handler: (ctx) => host(ctx as unknown as Context).exec(ctx.params.id, { op: "ready", userId: ctx.user.id, ready: ctx.body.ready }),
    }),
    route.post(`${prefix}/:id/leave`, {
      name: "lobby_leave",
      summary: "Leave a lobby",
      tags: ["game"],
      auth: "required",
      mcp: false,
      params: idParam,
      handler: async (ctx) => ({ left: (await host(ctx as unknown as Context).exec(ctx.params.id, { op: "leave", userId: ctx.user.id })).left ?? false }),
    }),
    route.post(`${prefix}/:id/start`, {
      name: "lobby_start",
      summary: "Host: start the match once everyone is ready (creates the room)",
      tags: ["game"],
      auth: "required",
      mcp: false,
      params: idParam,
      handler: async (ctx) => {
        const h = host(ctx as unknown as Context);
        const id = ctx.params.id;
        const { spec, lobby } = await h.exec(id, { op: "start", userId: ctx.user.id });
        let room: RoomRef;
        try {
          const data: GameRoomData = { match: { id: spec!.id, queue: "lobby", rated: false, players: spec!.players.map(({ userId, name, team }) => ({ userId, name, team })), teams: spec!.teams } };
          const env = ctx.runtime === "workerd" ? (ctx.env as Record<string, unknown>) : undefined;
          const created = await opts.rooms.createRoom(lobby.roomType, env ? { data, env, code: false } : { data, code: false });
          await store(ctx.env).createMatch(spec!, "none", created.id);
          room = { type: lobby.roomType, id: created.id, url: `${roomsPath}/${lobby.roomType}/${created.id}` };
        } catch (err) {
          await h.exec(id, { op: "startFailed" });
          throw isMiuError(err) ? err : errors.internal("Could not create the lobby's room", err);
        }
        const r = await h.exec(id, { op: "started", room });
        return { lobby: r.lobby, ticket: await ticketFor(r.lobby, ctx.user.id) };
      },
    }),
  ];

  const gate = ticketGate({ roomsPath, types: () => [opts.room], secret: key, clock });

  const plugin = definePlugin({
    name: "lobbies",
    routes,
    onRequest(ctx: Context) {
      lastEnv = ctx.env;
      return gate(ctx);
    },
    inspect: () => ({ path: prefix, room: opts.room, minPlayers, maxPlayers, teams, codeTtlMs: codeTtl, open: [...local.values()].filter((l) => l.view().status === "open").length, durableObject: { binding, className } }),
    cloudflare: (): CloudflareNeeds => {
      const needs: CloudflareNeeds = { durableObjects: [{ binding, className }] };
      if (opts.codes) needs.kv = [opts.codes];
      if (isD1Ref(source)) needs.d1 = [source.binding];
      return needs;
    },
    /** Shutdown: forget local lobbies and unregister this plugin's result sink. */
    stop(): void {
      for (const [id, core] of [...local]) forget(id, core);
      unregisterSink();
    },
    [INTERNAL]: { clock },
  });
  return plugin;
}

export type Lobbies = ReturnType<typeof lobbies>;

/** Cloudflare: one Durable Object per lobby. Export it as `MiuLobbies` (binding MIU_LOBBY). */
export function createLobbyDurableObject(lb: Lobbies, o: { clock?: Clock } = {}) {
  const clock = o.clock ?? (lb as unknown as Record<symbol, { clock: Clock }>)[INTERNAL]?.clock ?? systemClock;
  return class MiuLobbiesDurableObject {
    private state: { storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> } };
    private core: LobbyCore | null | undefined = undefined;

    constructor(state: { storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> }; getWebSockets?(): CfWebSocketLike[] }, _env: unknown) {
      this.state = state;
    }

    async fetch(req: Request): Promise<Response> {
      try {
        if (this.core === undefined) {
          const snap = (await this.state.storage.get("miu:lobby")) as LobbySnapshot | undefined;
          this.core = snap ? LobbyCore.restore(snap) : null;
        }
        const { core, reply } = execLobby(this.core, (await req.json()) as LobbyRequest, clock.now());
        this.core = core;
        await this.state.storage.put("miu:lobby", core.snapshot());
        return Response.json({ ok: reply });
      } catch (err) {
        return isMiuError(err) ? err.toResponse() : errors.internal().toResponse();
      }
    }
  };
}
