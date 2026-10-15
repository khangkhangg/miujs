// One matchmaking queue as a pure, snapshot-able state machine. No clock, no I/O: callers pass
// `now`, so it runs the same in memory, inside a Durable Object and under a fake clock.
//
// Matching: the oldest waiting player anchors a match and takes the closest ratings inside its
// window. The window starts at `initialWindow` and widens by `widenBy` every `widenAfterMs`.
// Players still waiting after `maxWaitMs` time out.

import { gameErrors } from "./errors.ts";

export type RatingSystem = "elo" | "glicko2-lite";

export interface QueueConfig {
  /** Realtime room type to create for each match. */
  room: string;
  /** Players per team. */
  teamSize: number;
  /** Teams per match. Default 2. */
  teams?: number;
  rating: RatingSystem;
  /** Widen the rating window every this many ms of waiting. */
  widenAfterMs: number;
  /** Give up (status `timeout`) after waiting this long. */
  maxWaitMs: number;
  /** Allowed regions; players then pick one when joining and only meet their region. */
  region?: string[];
  /** Starting rating window (± points). Default 100. */
  initialWindow?: number;
  /** Added to the window every `widenAfterMs`. Default 100. */
  widenBy?: number;
  /** Largest window. Default unlimited. */
  maxWindow?: number;
  /** How long matched/timeout statuses stay readable. Default 5 minutes. */
  statusTtlMs?: number;
}

export interface QueueEntry {
  userId: string;
  name: string;
  rating: number;
  region?: string;
}

interface Waiting extends QueueEntry {
  joinedAt: number;
  seq: number;
}

export interface MatchPlayer {
  userId: string;
  name: string;
  rating: number;
  team: number;
}

export interface MatchSpec {
  id: string;
  queue: string;
  room: string;
  region?: string;
  createdAt: number;
  players: MatchPlayer[];
  /** User ids per team. */
  teams: string[][];
}

export interface RoomRef {
  type: string;
  id: string;
  /** Path to connect to, e.g. `/rooms/arena/r1a2`. */
  url: string;
}

export interface Assignment {
  room: RoomRef;
  ticket: string;
  team: number;
}

export type QueueStatus =
  | { state: "idle" }
  | { state: "queued"; since: number; window: number; region?: string }
  | { state: "matching"; matchId: string; at: number }
  | ({ state: "matched"; matchId: string; at: number } & Assignment)
  | { state: "timeout"; at: number }
  | { state: "failed"; at: number; error: string };

type Kept = Exclude<QueueStatus, { state: "idle" } | { state: "queued" }>;

export interface QueueSnapshot {
  v: 1;
  seq: number;
  waiting: Waiting[];
  statuses: Record<string, Kept>;
}

export interface QueueCoreOptions {
  /** Match id generator. Default: random. */
  matchId?: () => string;
}

function randomMatchId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "m";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function checkQueueConfig(name: string, cfg: QueueConfig): void {
  const fail = (what: string, fix: string) => {
    throw gameErrors.queueConfig(`Queue "${name}": ${what}`, fix);
  };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail("name must be 1-64 letters, digits, '_' or '-'", 'Rename it, e.g. queues: { ranked: { ... } }.');
  if (!Number.isInteger(cfg.teamSize) || cfg.teamSize < 1) fail("teamSize must be a positive integer", "Use teamSize: 1 for duels, 2+ for team games.");
  if (!Number.isInteger(cfg.teams ?? 2) || (cfg.teams ?? 2) < 2) fail("teams must be an integer >= 2", "Use teams: 2 for a head-to-head match.");
  if (cfg.rating !== "elo" && cfg.rating !== "glicko2-lite") fail(`unknown rating "${String(cfg.rating)}"`, 'Use rating: "elo" or "glicko2-lite".');
  if (!(cfg.widenAfterMs > 0)) fail("widenAfterMs must be > 0", "e.g. widenAfterMs: 5000 widens the window every 5 seconds.");
  if (!(cfg.maxWaitMs > 0)) fail("maxWaitMs must be > 0", "e.g. maxWaitMs: 120000 gives up after 2 minutes.");
  if (typeof cfg.room !== "string" || !cfg.room) fail("needs a room type", 'Add room: "arena" (a room in rooms({ rooms: [...] })).');
  if (cfg.region && (!Array.isArray(cfg.region) || !cfg.region.length)) fail("region must be a non-empty list", 'e.g. region: ["eu", "us"].');
}

export class QueueCore {
  readonly name: string;
  private cfg: Required<Omit<QueueConfig, "region">> & { region?: string[] };
  private waiting: Waiting[] = [];
  private statuses = new Map<string, Kept>();
  private seq = 0;
  private nextId: () => string;

  constructor(name: string, cfg: QueueConfig, opts: QueueCoreOptions = {}) {
    checkQueueConfig(name, cfg);
    this.name = name;
    this.cfg = { teams: 2, initialWindow: 100, widenBy: 100, maxWindow: Infinity, statusTtlMs: 300_000, ...cfg };
    this.nextId = opts.matchId ?? randomMatchId;
  }

  static restore(name: string, cfg: QueueConfig, snap: QueueSnapshot | undefined, opts: QueueCoreOptions = {}): QueueCore {
    const q = new QueueCore(name, cfg, opts);
    if (snap) {
      q.seq = snap.seq;
      q.waiting = snap.waiting.map((w) => ({ ...w }));
      for (const [k, v] of Object.entries(snap.statuses)) q.statuses.set(k, { ...v } as Kept);
    }
    return q;
  }

  snapshot(): QueueSnapshot {
    return { v: 1, seq: this.seq, waiting: this.waiting.map((w) => ({ ...w })), statuses: Object.fromEntries([...this.statuses].map(([k, v]) => [k, { ...v }])) };
  }

  get size(): number {
    return this.waiting.length;
  }

  get config(): Readonly<QueueConfig> {
    return this.cfg;
  }

  /** Players per match. */
  get matchSize(): number {
    return this.cfg.teamSize * this.cfg.teams;
  }

  window(w: { joinedAt: number }, now: number): number {
    const steps = Math.floor(Math.max(0, now - w.joinedAt) / this.cfg.widenAfterMs);
    return Math.min(this.cfg.maxWindow, this.cfg.initialWindow + steps * this.cfg.widenBy);
  }

  join(entry: QueueEntry, now: number): QueueStatus {
    const regions = this.cfg.region;
    if (regions && (!entry.region || !regions.includes(entry.region))) throw gameErrors.regionRequired(regions);
    const s = this.statuses.get(entry.userId);
    if (this.waiting.some((w) => w.userId === entry.userId) || s?.state === "matching") throw gameErrors.alreadyQueued(this.name);
    this.statuses.delete(entry.userId);
    const w: Waiting = { userId: entry.userId, name: entry.name, rating: entry.rating, joinedAt: now, seq: ++this.seq };
    if (regions) w.region = entry.region;
    this.waiting.push(w);
    return this.status(entry.userId, now);
  }

  leave(userId: string): boolean {
    const i = this.waiting.findIndex((w) => w.userId === userId);
    if (i === -1) return false;
    this.waiting.splice(i, 1);
    return true;
  }

  status(userId: string, now: number): QueueStatus {
    const w = this.waiting.find((x) => x.userId === userId);
    if (w) {
      const s: QueueStatus = { state: "queued", since: w.joinedAt, window: this.window(w, now) };
      if (w.region) s.region = w.region;
      return s;
    }
    const kept = this.statuses.get(userId);
    if (kept && !this.expired(kept, now)) return { ...kept };
    return { state: "idle" };
  }

  /** Expire old statuses, time out long waits, and form every match possible at `now`. */
  run(now: number): { matches: MatchSpec[]; timedOut: string[] } {
    for (const [k, v] of this.statuses) if (this.expired(v, now)) this.statuses.delete(k);
    const timedOut: string[] = [];
    this.waiting = this.waiting.filter((w) => {
      if (now - w.joinedAt < this.cfg.maxWaitMs) return true;
      timedOut.push(w.userId);
      this.statuses.set(w.userId, { state: "timeout", at: now });
      return false;
    });
    const matches: MatchSpec[] = [];
    const need = this.matchSize;
    const byAge = (a: Waiting, b: Waiting) => a.joinedAt - b.joinedAt || a.seq - b.seq;
    const order = [...this.waiting].sort(byAge);
    const used = new Set<Waiting>();
    // Per region, players sorted by rating (stable, so equal ratings stay oldest first). Each
    // anchor then walks outwards from its own position instead of filtering and sorting the whole
    // queue: O(n log n) per run instead of O(n² log n), with the same picks.
    const lists = new Map<string | undefined, Waiting[]>();
    for (const w of order) {
      const l = lists.get(w.region);
      if (l) l.push(w);
      else lists.set(w.region, [w]);
    }
    const pos = new Map<Waiting, number>();
    for (const l of lists.values()) {
      l.sort((a, b) => a.rating - b.rating);
      l.forEach((w, i) => pos.set(w, i));
    }
    for (const anchor of order) {
      if (used.has(anchor)) continue;
      const win = this.window(anchor, now);
      const list = lists.get(anchor.region)!;
      const at = pos.get(anchor)!;
      const picks: Waiting[] = [];
      let lo = at - 1;
      let hi = at + 1;
      while (picks.length < need - 1) {
        while (lo >= 0 && used.has(list[lo])) lo--;
        while (hi < list.length && used.has(list[hi])) hi++;
        const d = Math.min(lo >= 0 ? anchor.rating - list[lo].rating : Infinity, hi < list.length ? list[hi].rating - anchor.rating : Infinity);
        if (!(d <= win)) break;
        // Everyone at exactly this distance, from both sides, oldest first (the original tie-break).
        const tier: Waiting[] = [];
        for (; lo >= 0 && (used.has(list[lo]) || anchor.rating - list[lo].rating === d); lo--) if (!used.has(list[lo])) tier.push(list[lo]);
        for (; hi < list.length && (used.has(list[hi]) || list[hi].rating - anchor.rating === d); hi++) if (!used.has(list[hi])) tier.push(list[hi]);
        tier.sort(byAge);
        for (const w of tier) picks.push(w);
      }
      picks.length = Math.min(picks.length, need - 1);
      if (picks.length < need - 1) continue;
      const group = [anchor, ...picks];
      for (const w of group) used.add(w);
      matches.push(this.form(group, now));
    }
    if (used.size) this.waiting = this.waiting.filter((w) => !used.has(w));
    return { matches, timedOut };
  }

  /** The match's room is ready: store each player's room and ticket. */
  assign(matchId: string, assignments: Record<string, Assignment>, now: number): void {
    for (const [userId, a] of Object.entries(assignments)) {
      this.statuses.set(userId, { state: "matched", matchId, room: { ...a.room }, ticket: a.ticket, team: a.team, at: now });
    }
  }

  /** Creating the match failed: tell its players (they can queue again). */
  fail(matchId: string, userIds: string[], error: string, now: number): void {
    for (const u of userIds) {
      const s = this.statuses.get(u);
      if (s && s.state === "matching" && s.matchId === matchId) this.statuses.set(u, { state: "failed", at: now, error });
    }
  }

  /** Earliest time `run()` could change something (a widening, a timeout, a status expiry). */
  nextDue(now: number): number | null {
    let due: number | null = null;
    const at = (t: number) => {
      if (t > now && (due === null || t < due)) due = t;
    };
    for (const w of this.waiting) {
      at(w.joinedAt + this.cfg.maxWaitMs);
      const steps = Math.floor(Math.max(0, now - w.joinedAt) / this.cfg.widenAfterMs) + 1;
      if (this.window(w, now) < this.cfg.maxWindow) at(w.joinedAt + steps * this.cfg.widenAfterMs);
    }
    for (const s of this.statuses.values()) at(s.at + this.cfg.statusTtlMs);
    return due;
  }

  /** Every kept status expires, "matching" too (a safety net if creating the room never finished). */
  private expired(s: Kept, now: number): boolean {
    return now >= s.at + this.cfg.statusTtlMs;
  }

  private form(group: Waiting[], now: number): MatchSpec {
    const teams = this.cfg.teams;
    const ranked = [...group].sort((a, b) => b.rating - a.rating || a.seq - b.seq);
    const teamOf = new Map<Waiting, number>();
    ranked.forEach((w, i) => {
      const round = Math.floor(i / teams);
      const pos = i % teams;
      teamOf.set(w, round % 2 === 0 ? pos : teams - 1 - pos);
    });
    const id = this.nextId();
    const spec: MatchSpec = {
      id,
      queue: this.name,
      room: this.cfg.room,
      createdAt: now,
      players: group.map((w) => ({ userId: w.userId, name: w.name, rating: w.rating, team: teamOf.get(w)! })),
      teams: Array.from({ length: teams }, (_, t) => ranked.filter((w) => teamOf.get(w) === t).map((w) => w.userId)),
    };
    if (group[0].region) spec.region = group[0].region;
    for (const w of group) this.statuses.set(w.userId, { state: "matching", matchId: id, at: now });
    return spec;
  }
}
