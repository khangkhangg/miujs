// One private lobby as a pure, snapshot-able state machine: members join with a code, ready up,
// and the host starts the match. No I/O, so it runs in memory or inside a Durable Object.

import { gameErrors } from "./errors.ts";
import type { MatchSpec, RoomRef } from "./queue.ts";

export interface LobbyInit {
  id: string;
  code: string;
  roomType: string;
  hostId: string;
  hostName: string;
  minPlayers: number;
  maxPlayers: number;
  /** Members are spread over this many teams in join order. */
  teams: number;
  now: number;
}

interface Member {
  userId: string;
  name: string;
  ready: boolean;
  joinedAt: number;
}

export type LobbyStatus = "open" | "starting" | "started";

export interface LobbySnapshot {
  v: 1;
  id: string;
  code: string;
  roomType: string;
  hostId: string;
  minPlayers: number;
  maxPlayers: number;
  teams: number;
  createdAt: number;
  status: LobbyStatus;
  members: Member[];
  matchId?: string;
  room?: RoomRef;
}

export interface LobbyView {
  id: string;
  code: string;
  roomType: string;
  hostId: string;
  status: LobbyStatus;
  minPlayers: number;
  maxPlayers: number;
  members: { userId: string; name: string; ready: boolean; host: boolean; team: number }[];
  matchId?: string;
  room?: RoomRef;
}

function randomId(prefix: string): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = prefix;
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export class LobbyCore {
  private s: LobbySnapshot;

  constructor(init: LobbyInit) {
    this.s = {
      v: 1,
      id: init.id,
      code: init.code,
      roomType: init.roomType,
      hostId: init.hostId,
      minPlayers: init.minPlayers,
      maxPlayers: init.maxPlayers,
      teams: init.teams,
      createdAt: init.now,
      status: "open",
      members: [{ userId: init.hostId, name: init.hostName, ready: false, joinedAt: init.now }],
    };
  }

  static restore(snap: LobbySnapshot): LobbyCore {
    const l = Object.create(LobbyCore.prototype) as LobbyCore;
    l.s = structuredClone(snap);
    return l;
  }

  snapshot(): LobbySnapshot {
    return structuredClone(this.s);
  }

  get createdAt(): number {
    return this.s.createdAt;
  }

  isMember(userId: string): boolean {
    return this.s.members.some((m) => m.userId === userId);
  }

  memberName(userId: string): string | undefined {
    return this.s.members.find((m) => m.userId === userId)?.name;
  }

  view(): LobbyView {
    const v: LobbyView = {
      id: this.s.id,
      code: this.s.code,
      roomType: this.s.roomType,
      hostId: this.s.hostId,
      status: this.s.status,
      minPlayers: this.s.minPlayers,
      maxPlayers: this.s.maxPlayers,
      members: this.s.members.map((m, i) => ({ userId: m.userId, name: m.name, ready: m.ready, host: m.userId === this.s.hostId, team: i % this.s.teams })),
    };
    if (this.s.matchId) v.matchId = this.s.matchId;
    if (this.s.room) v.room = { ...this.s.room };
    return v;
  }

  join(userId: string, name: string, now: number): void {
    if (this.isMember(userId)) return;
    if (this.s.status !== "open") throw gameErrors.lobbyStarted();
    if (this.s.members.length >= this.s.maxPlayers) throw gameErrors.lobbyFull(this.s.maxPlayers);
    this.s.members.push({ userId, name, ready: false, joinedAt: now });
  }

  leave(userId: string): boolean {
    const i = this.s.members.findIndex((m) => m.userId === userId);
    if (i === -1) return false;
    this.s.members.splice(i, 1);
    if (this.s.hostId === userId && this.s.members.length) this.s.hostId = this.s.members[0].userId;
    return true;
  }

  ready(userId: string, ready: boolean): void {
    const m = this.s.members.find((x) => x.userId === userId);
    if (!m) throw gameErrors.lobbyNotMember();
    if (this.s.status !== "open") throw gameErrors.lobbyStarted();
    m.ready = ready;
  }

  /** Host only, everyone else ready, enough players. Returns the match to create. */
  start(userId: string, now: number): MatchSpec {
    if (!this.isMember(userId)) throw gameErrors.lobbyNotMember();
    if (userId !== this.s.hostId) throw gameErrors.lobbyNotHost();
    if (this.s.status !== "open") throw gameErrors.lobbyStarted();
    const notReady = this.s.members.filter((m) => m.userId !== this.s.hostId && !m.ready).map((m) => m.name);
    if (notReady.length || this.s.members.length < this.s.minPlayers) throw gameErrors.lobbyNotReady(notReady, this.s.minPlayers);
    const id = randomId("m");
    this.s.status = "starting";
    this.s.matchId = id;
    const players = this.s.members.map((m, i) => ({ userId: m.userId, name: m.name, rating: 0, team: i % this.s.teams }));
    const teams = Array.from({ length: this.s.teams }, (_, t) => players.filter((p) => p.team === t).map((p) => p.userId)).filter((tm) => tm.length);
    return { id, queue: "lobby", room: this.s.roomType, createdAt: now, players, teams };
  }

  started(room: RoomRef): void {
    this.s.status = "started";
    this.s.room = { ...room };
  }

  startFailed(): void {
    this.s.status = "open";
    delete this.s.matchId;
  }
}

/** A new lobby id. */
export function lobbyId(): string {
  return randomId("l");
}
