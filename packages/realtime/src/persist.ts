// Room snapshots in Durable Object storage, split by section so a big room never hits the
// per-value limit (128 KiB on KV-backed objects, 2 MB on SQLite-backed ones) and a change to one
// section does not rewrite the others:
//
//   miu:room                      header: { v: 2, type, id, createdAt, hostKey, timers, state, players, secret }
//   miu:room:<section>:<gen>:<i>  JSON text chunks of a section too big to sit in the header
//   miu:room:secret               a secret that is not plain JSON (Map, Date, ...), stored as one value
//
// Each section in the header is a part: `{ j }` (inline JSON text), `{ n, g }` (n chunks of
// generation g) or `{ raw: true }`. A rewrite puts new chunks first and the header last, then
// deletes the old generation, so a crash in between leaves the previous snapshot readable.
// Snapshots written by older versions (`v: 1`, everything in `miu:room`) still load.

import { errors } from "miujs";
import type { RoomSnapshot } from "./room.ts";

export const SNAPSHOT_KEY = "miu:room";
/** Chunk size in UTF-16 code units: under 128 KiB even if every character took two bytes. */
export const CHUNK_CHARS = 60_000;
/** Sections up to this size stay inline in the header. */
export const INLINE_CHARS = 16_384;
/** Default `maxSnapshotBytes`. */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export interface SnapshotStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface Part {
  /** Inline JSON text. */
  j?: string;
  /** Number of chunks and their generation. */
  n?: number;
  g?: number;
  /** Stored as one structured value at `miu:room:<section>`. */
  raw?: true;
}

const SECTIONS = ["state", "players", "secret"] as const;
type Section = (typeof SECTIONS)[number];

interface Header {
  v: 2;
  type: string;
  id: string;
  createdAt: number;
  hostKey: string;
  timers?: RoomSnapshot["timers"];
  state: Part;
  players: Part;
  secret: Part;
}

export interface PersistStats {
  /** Snapshots written (header plus any changed sections). */
  writes: number;
  /** Persist points where nothing had changed, so nothing was written. */
  skipped: number;
  /** Writes refused or failed (each one logged with its MIU_E_* code). */
  failures: number;
  /** Size of the last persisted snapshot across all its keys (JSON characters, ≈ bytes). */
  lastBytes: number;
  /** How much the last write actually wrote (unchanged sections are not rewritten). */
  lastWriteBytes: number;
  /** Keys the last persisted snapshot spans. */
  lastKeys: number;
  bytesWritten: number;
  keysWritten: number;
  /** Room clock time of the last successful write. */
  lastAt: number | null;
  lastError: { code: string; message: string; at: number } | null;
}

export function emptyStats(): PersistStats {
  return { writes: 0, skipped: 0, failures: 0, lastBytes: 0, lastWriteBytes: 0, lastKeys: 0, bytesWritten: 0, keysWritten: 0, lastAt: null, lastError: null };
}

/** True when `JSON.parse(JSON.stringify(v))` gives back an equal value. */
export function isPlainJson(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) {
    for (const x of v) if (x === undefined || !isPlainJson(x)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k of Object.keys(v)) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined && !isPlainJson(x)) return false;
  }
  return true;
}

const RAW = Symbol("raw");
const chunkKey = (s: Section, g: number, i: number) => `${SNAPSHOT_KEY}:${s}:${g}:${i}`;
const rawKey = (s: Section) => `${SNAPSHOT_KEY}:${s}`;

function partKeys(s: Section, p: Part | undefined): string[] {
  if (!p) return [];
  if (p.raw) return [rawKey(s)];
  const out: string[] = [];
  if (p.n && p.g !== undefined) for (let i = 0; i < p.n; i++) out.push(chunkKey(s, p.g, i));
  return out;
}

function corrupt(key: string) {
  return errors.custom({
    code: "MIU_E_ROOM_SNAPSHOT_CORRUPT",
    status: 500,
    message: `The stored room snapshot is incomplete: ${key} is missing`,
    fix: "Close the room (manage → Close room, or delete the miu:room* keys of this Durable Object) and create it again.",
  });
}

/** Read a snapshot (either format) without keeping any bookkeeping. */
export async function loadSnapshot(storage: SnapshotStorage): Promise<RoomSnapshot | undefined> {
  return (await new SnapshotStore(storage).load()) ?? undefined;
}

/** Writes and reads one room's snapshot, rewriting only the sections that changed. */
export class SnapshotStore {
  readonly stats = emptyStats();
  private storage: SnapshotStorage;
  private max: number;
  /** What storage holds now, per section: the JSON text (null for raw) and its part. */
  private held: Partial<Record<Section, { text: string | null; part: Part }>> = {};
  private header = "";
  private gen = 0;

  constructor(storage: SnapshotStorage, maxBytes = MAX_SNAPSHOT_BYTES) {
    this.storage = storage;
    this.max = maxBytes;
  }

  async load(): Promise<RoomSnapshot | null> {
    const h = (await this.storage.get(SNAPSHOT_KEY)) as Header | RoomSnapshot | undefined;
    if (!h) return null;
    if (h.v !== 2) return h as RoomSnapshot;
    const out: Record<string, unknown> = { v: 1, type: h.type, id: h.id, createdAt: h.createdAt, hostKey: h.hostKey, timers: h.timers ?? [] };
    for (const s of SECTIONS) {
      const p = h[s] ?? {};
      if (p.raw) {
        out[s] = await this.storage.get(rawKey(s));
        this.held[s] = { text: null, part: p };
        continue;
      }
      let text: string | undefined = p.j;
      if (p.n && p.g !== undefined) {
        const keys = partKeys(s, p);
        const parts = await Promise.all(keys.map((k) => this.storage.get(k)));
        parts.forEach((x, i) => {
          if (typeof x !== "string") throw corrupt(keys[i]);
        });
        text = parts.join("");
        this.gen = Math.max(this.gen, p.g);
      }
      out[s] = text === undefined ? undefined : JSON.parse(text);
      this.held[s] = { text: text ?? null, part: p };
    }
    this.header = JSON.stringify(h);
    return out as unknown as RoomSnapshot;
  }

  /**
   * Persist `snap`. Unchanged sections are kept as they are; returns false when nothing changed.
   * Throws MIU_E_ROOM_STATE_TOO_LARGE (nothing written) or the storage error.
   */
  async write(snap: RoomSnapshot, label: string, now: number): Promise<boolean> {
    const texts: Record<Section, string | undefined | typeof RAW> = {
      state: JSON.stringify(snap.state),
      players: JSON.stringify(snap.players),
      secret: isPlainJson(snap.secret) || snap.secret === undefined ? JSON.stringify(snap.secret) : RAW,
    };
    let total = 0;
    for (const s of SECTIONS) {
      const x = texts[s];
      if (typeof x === "string") total += x.length;
    }
    if (total > this.max) {
      throw errors.custom({
        code: "MIU_E_ROOM_STATE_TOO_LARGE",
        status: 500,
        message: `Room ${label} snapshot is ${total} bytes, over the ${this.max}-byte limit; it was not persisted (the room keeps running from memory)`,
        fix: "Keep less in room state and secret (move history and logs to room.storage, D1 or R2; send big data over HTTP), or raise createRoomDurableObject(rooms, { maxSnapshotBytes }).",
        details: { bytes: total, max: this.max },
      });
    }
    const puts: [string, unknown][] = [];
    const dels: string[] = [];
    const parts = {} as Record<Section, Part>;
    const next: Partial<Record<Section, { text: string | null; part: Part }>> = {};
    let gen = this.gen;
    for (const s of SECTIONS) {
      const text = texts[s];
      const prev = this.held[s];
      if (text !== RAW && prev && prev.text === (text ?? null) && !prev.part.raw) {
        parts[s] = prev.part;
        next[s] = prev;
        continue;
      }
      let part: Part;
      if (text === RAW) {
        part = { raw: true };
        puts.push([rawKey(s), snap[s]]);
      } else if (text === undefined) part = {};
      else if (text.length <= INLINE_CHARS) part = { j: text };
      else {
        const g = ++gen;
        const n = Math.ceil(text.length / CHUNK_CHARS);
        for (let i = 0; i < n; i++) puts.push([chunkKey(s, g, i), text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)]);
        part = { n, g };
      }
      parts[s] = part;
      next[s] = { text: text === RAW ? null : (text ?? null), part };
      for (const k of partKeys(s, prev?.part)) if (!(part.raw && k === rawKey(s))) dels.push(k);
    }
    const header: Header = { v: 2, type: snap.type, id: snap.id, createdAt: snap.createdAt, hostKey: snap.hostKey, timers: snap.timers, ...parts };
    const htext = JSON.stringify(header);
    if (htext === this.header && puts.length === 0) {
      this.stats.skipped++;
      return false;
    }
    // Chunks first, header last: until the header lands, the old snapshot is still whole.
    await Promise.all(puts.map(([k, v]) => this.storage.put(k, v)));
    await this.storage.put(SNAPSHOT_KEY, header);
    this.gen = gen;
    this.held = next;
    this.header = htext;
    let written = htext.length;
    for (const [, v] of puts) written += typeof v === "string" ? v.length : 0;
    let keys = 1;
    let size = htext.length;
    for (const s of SECTIONS) {
      keys += partKeys(s, parts[s]).length;
      if (parts[s].n) size += next[s]!.text!.length;
    }
    const st = this.stats;
    st.writes++;
    st.lastBytes = size;
    st.lastWriteBytes = written;
    st.lastKeys = keys;
    st.bytesWritten += written;
    st.keysWritten += puts.length + 1;
    st.lastAt = now;
    await Promise.all(dels.map((k) => this.storage.delete(k)));
    return true;
  }

  /** Delete every key of the stored snapshot. */
  async wipe(): Promise<void> {
    const keys = [SNAPSHOT_KEY];
    for (const s of SECTIONS) keys.push(...partKeys(s, this.held[s]?.part));
    this.held = {};
    this.header = "";
    await Promise.all(keys.map((k) => this.storage.delete(k)));
  }
}
