// Audit stores (memory, SQL) with a SHA-256 hash chain, chain verification and retention.

import { errors, type CloudflareNeeds, type Env } from "miujs";
import { describeDatabase, migrateOnce, resolveDatabase, type Database, type DatabaseSource, type Migration } from "@miujs/db";
import { canonicalJson, toCanonical, type Changes } from "./diff.ts";

/** `prevHash` of the first row ever written. */
export const GENESIS_HASH = "0".repeat(64);
export const CHECKPOINT_ACTION = "audit.checkpoint";

/** One audit row. `hash = sha256(prevHash + canonicalJson(row without prevHash/hash))`. */
export interface AuditRecord {
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  action: string;
  resource: string;
  resourceId: string | null;
  /** User id, or null for anonymous/system events. */
  actor: string | null;
  org: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  /** Changed fields only: `{ field: { before?, after? } }`. */
  changes: Changes | null;
  metadata: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
}

export type AuditInput = Omit<AuditRecord, "seq" | "prevHash" | "hash" | "resourceId" | "actor" | "org" | "ip" | "userAgent" | "requestId" | "changes" | "metadata"> &
  Partial<Pick<AuditRecord, "actor" | "org" | "ip" | "userAgent" | "requestId" | "changes" | "metadata">> & { resourceId?: string | number | null };

export interface AuditQuery {
  resource?: string;
  resourceId?: string;
  actor?: string;
  org?: string;
  /** Inclusive. Epoch ms, ISO string or Date. */
  since?: number | string | Date;
  /** Exclusive. Epoch ms, ISO string or Date. */
  until?: number | string | Date;
  /** 1–1000, default 50. */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
}

export interface AuditPage {
  /** Newest first. */
  items: AuditRecord[];
  nextCursor: string | null;
}

export interface AuditStore {
  readonly kind: string;
  /** Appends one row to the chain. Rows are never updated. */
  append(input: AuditInput, env?: Env): Promise<AuditRecord>;
  query(q: AuditQuery, env?: Env): Promise<AuditPage>;
  /** Rows with `seq > afterSeq`, oldest first (for verification). */
  scan(afterSeq: number, limit: number, env?: Env): Promise<AuditRecord[]>;
  /** The newest row. */
  head(env?: Env): Promise<AuditRecord | null>;
  /** Smallest seq with `ts >= ts`. */
  firstSeqSince(ts: number, env?: Env): Promise<number | null>;
  /** Deletes rows with `seq <= seq`. Use `purgeOlderThan`, which keeps the chain verifiable. */
  deleteThrough(seq: number, env?: Env): Promise<number>;
  inspect?(): Record<string, unknown>;
  cloudflare?(): CloudflareNeeds;
}

interface NormalizedQuery {
  resource?: string;
  resourceId?: string;
  actor?: string;
  org?: string;
  since?: number;
  until?: number;
  limit: number;
  before?: number;
}

interface Backend {
  kind: string;
  head(env: Env): Promise<AuditRecord | null>;
  /** False when `rec.seq` is taken (another writer won); the caller retries. */
  insert(rec: AuditRecord, env: Env): Promise<boolean>;
  query(q: NormalizedQuery, env: Env): Promise<AuditRecord[]>;
  scan(afterSeq: number, limit: number, env: Env): Promise<AuditRecord[]>;
  firstSeqSince(ts: number, env: Env): Promise<number | null>;
  deleteThrough(seq: number, env: Env): Promise<number>;
  inspect?(): Record<string, unknown>;
  cloudflare?(): CloudflareNeeds;
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

type Body = Omit<AuditRecord, "prevHash" | "hash">;

/** The hashed part of a row, in a fixed shape. */
function bodyOf(r: AuditRecord | Body): Body {
  return {
    seq: r.seq,
    ts: r.ts,
    action: r.action,
    resource: r.resource,
    resourceId: r.resourceId,
    actor: r.actor,
    org: r.org,
    ip: r.ip,
    userAgent: r.userAgent,
    requestId: r.requestId,
    changes: r.changes,
    metadata: r.metadata,
  };
}

export function hashRow(prevHash: string, row: AuditRecord | Body): Promise<string> {
  return sha256Hex(prevHash + canonicalJson(bodyOf(row)));
}

const invalidEntry = (why: string) =>
  errors.custom({
    code: "MIU_E_AUDIT_INVALID",
    status: 500,
    message: `Invalid audit entry: ${why}`,
    fix: 'Call ctx.audit.log({ action: "update", resource: "contacts", resourceId, before, after }) with non-empty action and resource strings.',
  });

const str = (v: unknown, max = 1000): string | null => (v === undefined || v === null ? null : String(v).slice(0, max));

function normalizeInput(input: AuditInput): Omit<Body, "seq"> {
  if (typeof input.action !== "string" || !input.action || input.action.length > 200) throw invalidEntry("action must be a 1–200 character string");
  if (typeof input.resource !== "string" || !input.resource || input.resource.length > 200) throw invalidEntry("resource must be a 1–200 character string");
  const ts = typeof input.ts === "number" && Number.isFinite(input.ts) ? Math.trunc(input.ts) : Date.now();
  return {
    ts,
    action: input.action,
    resource: input.resource,
    resourceId: str(input.resourceId, 200),
    actor: str(input.actor, 200),
    org: str(input.org, 200),
    ip: str(input.ip, 100),
    userAgent: str(input.userAgent, 500),
    requestId: str(input.requestId, 200),
    changes: input.changes == null ? null : toCanonical<Changes>(input.changes),
    metadata: input.metadata == null ? null : toCanonical<Record<string, unknown>>(input.metadata),
  };
}

const badQuery = (why: string) =>
  errors.custom({
    code: "MIU_E_AUDIT_QUERY_INVALID",
    status: 400,
    message: `Invalid audit query: ${why}`,
    fix: "Use limit 1–1000, since/until as epoch milliseconds or ISO dates, and cursor exactly as returned in nextCursor.",
  });

function toTime(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let n: number;
  if (v instanceof Date) n = v.getTime();
  else if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\d+$/.test(v)) n = Number(v);
  else if (typeof v === "string") n = Date.parse(v);
  else n = Number.NaN;
  if (!Number.isFinite(n)) throw badQuery(`${name} is not a date`);
  return n;
}

function normalizeQuery(q: AuditQuery): NormalizedQuery {
  const limit = q.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw badQuery("limit must be an integer from 1 to 1000");
  let before: number | undefined;
  if (q.cursor !== undefined && q.cursor !== null && q.cursor !== "") {
    if (typeof q.cursor !== "string" || !/^\d{1,15}$/.test(q.cursor)) throw badQuery("cursor is not one this API returned");
    before = Number(q.cursor);
  }
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  return {
    resource: s(q.resource),
    resourceId: s(q.resourceId),
    actor: s(q.actor),
    org: s(q.org),
    since: toTime(q.since, "since"),
    until: toTime(q.until, "until"),
    limit,
    before,
  };
}

function chained(backend: Backend): AuditStore {
  let tail: Promise<unknown> = Promise.resolve();
  const appendOnce = async (input: AuditInput, env: Env): Promise<AuditRecord> => {
    const base = normalizeInput(input);
    for (let attempt = 0; attempt < 25; attempt++) {
      const head = await backend.head(env);
      const body: Body = { seq: (head?.seq ?? 0) + 1, ...base };
      const prevHash = head?.hash ?? GENESIS_HASH;
      const rec: AuditRecord = { ...body, prevHash, hash: await hashRow(prevHash, body) };
      if (await backend.insert(rec, env)) return structuredClone(rec);
    }
    throw errors.custom({
      code: "MIU_E_AUDIT_APPEND_CONFLICT",
      status: 503,
      message: "Could not append to the audit log: too many concurrent writers",
      fix: "Retry the request. If this persists, check for a stuck writer or reduce write concurrency.",
    });
  };
  return {
    kind: backend.kind,
    append(input, env = {}) {
      // Serialize appends in this isolate; across isolates the unique seq makes losers retry.
      const p = tail.then(() => appendOnce(input, env));
      tail = p.catch(() => {});
      return p;
    },
    async query(q, env = {}) {
      const nq = normalizeQuery(q);
      const rows = await backend.query({ ...nq, limit: nq.limit + 1 }, env);
      const items = rows.slice(0, nq.limit);
      return { items, nextCursor: rows.length > nq.limit ? String(items[items.length - 1].seq) : null };
    },
    scan: (afterSeq, limit, env = {}) => backend.scan(afterSeq, limit, env),
    head: (env = {}) => backend.head(env),
    firstSeqSince: (ts, env = {}) => backend.firstSeqSince(ts, env),
    deleteThrough: (seq, env = {}) => backend.deleteThrough(seq, env),
    inspect: backend.inspect,
    cloudflare: backend.cloudflare,
  };
}

function matches(r: AuditRecord, q: NormalizedQuery): boolean {
  return (
    (q.resource === undefined || r.resource === q.resource) &&
    (q.resourceId === undefined || r.resourceId === q.resourceId) &&
    (q.actor === undefined || r.actor === q.actor) &&
    (q.org === undefined || r.org === q.org) &&
    (q.since === undefined || r.ts >= q.since) &&
    (q.until === undefined || r.ts < q.until) &&
    (q.before === undefined || r.seq < q.before)
  );
}

/** In-process audit log. For dev and tests; lost on restart. */
export function memoryAuditStore(): AuditStore {
  const rows: AuditRecord[] = [];
  const clone = (r: AuditRecord) => structuredClone(r);
  return chained({
    kind: "memory",
    async head() {
      return rows.length ? clone(rows[rows.length - 1]) : null;
    },
    async insert(rec) {
      if (rows.length && rows[rows.length - 1].seq >= rec.seq) return false;
      rows.push(clone(rec));
      return true;
    },
    async query(q) {
      const out: AuditRecord[] = [];
      for (let i = rows.length - 1; i >= 0 && out.length < q.limit; i--) if (matches(rows[i], q)) out.push(clone(rows[i]));
      return out;
    },
    async scan(afterSeq, limit) {
      return rows.filter((r) => r.seq > afterSeq).slice(0, limit).map(clone);
    },
    async firstSeqSince(ts) {
      return rows.find((r) => r.ts >= ts)?.seq ?? null;
    },
    async deleteThrough(seq) {
      let n = 0;
      while (rows.length && rows[0].seq <= seq) {
        rows.shift();
        n++;
      }
      return n;
    },
    inspect: () => ({ store: "memory", rows: rows.length }),
  });
}

export interface DbAuditStoreOptions {
  /** Default `audit_log`. */
  table?: string;
}

function migrationsFor(table: string): Migration[] {
  return [
    {
      id: `audit_001_${table}`,
      sql: `
        CREATE TABLE IF NOT EXISTS ${table} (
          seq INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          resource_id TEXT,
          actor TEXT,
          org_id TEXT,
          ip TEXT,
          user_agent TEXT,
          request_id TEXT,
          changes TEXT,
          metadata TEXT,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${table}_resource ON ${table} (resource, resource_id, seq);
        CREATE INDEX IF NOT EXISTS ${table}_actor ON ${table} (actor, seq);
        CREATE INDEX IF NOT EXISTS ${table}_org ON ${table} (org_id, seq);
        CREATE INDEX IF NOT EXISTS ${table}_ts ON ${table} (ts);
      `,
    },
  ];
}

const fromRow = (r: any): AuditRecord => ({
  seq: Number(r.seq),
  ts: Number(r.ts),
  action: r.action,
  resource: r.resource,
  resourceId: r.resource_id ?? null,
  actor: r.actor ?? null,
  org: r.org_id ?? null,
  ip: r.ip ?? null,
  userAgent: r.user_agent ?? null,
  requestId: r.request_id ?? null,
  changes: r.changes == null ? null : JSON.parse(r.changes),
  metadata: r.metadata == null ? null : JSON.parse(r.metadata),
  prevHash: r.prev_hash,
  hash: r.hash,
});

const isConflict = (err: unknown) => /unique|primary key|constraint/i.test(String((err as Error)?.message ?? err));

/**
 * Append-only SQL audit log (D1 or bun:sqlite). UPDATEs are rejected by a trigger; every row
 * carries a hash chain so edits and deletions show up in `verifyChain`.
 */
export function dbAuditStore(source: DatabaseSource, opts: DbAuditStoreOptions = {}): AuditStore {
  const table = opts.table ?? "audit_log";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) {
    throw errors.config("MIU_E_AUDIT_TABLE_INVALID", `Invalid audit table name ${JSON.stringify(table)}`, "Use letters, digits and underscores, starting with a letter or underscore.");
  }
  const migrations = migrationsFor(table);
  const ready = new WeakMap<Database, Promise<void>>();
  const get = async (env: Env): Promise<Database> => {
    const database = resolveDatabase(source, env);
    let p = ready.get(database);
    if (!p) {
      p = (async () => {
        await migrateOnce(database, migrations);
        // Run alone: migration splitting would cut the trigger body at its `;`.
        await database.prepare(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`).run();
      })();
      p.catch(() => ready.delete(database));
      ready.set(database, p);
    }
    await p;
    return database;
  };
  const cols = "seq, ts, action, resource, resource_id, actor, org_id, ip, user_agent, request_id, changes, metadata, prev_hash, hash";

  return chained({
    kind: "db",
    async head(env) {
      const r = await (await get(env)).prepare(`SELECT ${cols} FROM ${table} ORDER BY seq DESC LIMIT 1`).first();
      return r ? fromRow(r) : null;
    },
    async insert(rec, env) {
      const database = await get(env);
      try {
        await database
          .prepare(`INSERT INTO ${table} (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            rec.seq,
            rec.ts,
            rec.action,
            rec.resource,
            rec.resourceId,
            rec.actor,
            rec.org,
            rec.ip,
            rec.userAgent,
            rec.requestId,
            rec.changes === null ? null : canonicalJson(rec.changes),
            rec.metadata === null ? null : canonicalJson(rec.metadata),
            rec.prevHash,
            rec.hash,
          )
          .run();
        return true;
      } catch (err) {
        if (isConflict(err)) return false;
        throw err;
      }
    },
    async query(q, env) {
      const where: string[] = [];
      const values: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        where.push(sql);
        values.push(v);
      };
      if (q.resource !== undefined) add("resource = ?", q.resource);
      if (q.resourceId !== undefined) add("resource_id = ?", q.resourceId);
      if (q.actor !== undefined) add("actor = ?", q.actor);
      if (q.org !== undefined) add("org_id = ?", q.org);
      if (q.since !== undefined) add("ts >= ?", q.since);
      if (q.until !== undefined) add("ts < ?", q.until);
      if (q.before !== undefined) add("seq < ?", q.before);
      values.push(q.limit);
      const sql = `SELECT ${cols} FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`;
      const { results } = await (await get(env)).prepare(sql).bind(...values).all();
      return results.map(fromRow);
    },
    async scan(afterSeq, limit, env) {
      const { results } = await (await get(env)).prepare(`SELECT ${cols} FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?`).bind(afterSeq, limit).all();
      return results.map(fromRow);
    },
    async firstSeqSince(ts, env) {
      const v = await (await get(env)).prepare(`SELECT MIN(seq) AS s FROM ${table} WHERE ts >= ?`).bind(ts).first<number | null>("s");
      return v === null || v === undefined ? null : Number(v);
    },
    async deleteThrough(seq, env) {
      const r = await (await get(env)).prepare(`DELETE FROM ${table} WHERE seq <= ?`).bind(seq).run();
      return r.meta.changes;
    },
    inspect: () => ({ store: "db", table, database: describeDatabase(source) }),
    cloudflare(): CloudflareNeeds {
      const d = describeDatabase(source);
      return d.adapter === "d1" && typeof d.binding === "string" ? { d1: [d.binding] } : {};
    },
  });
}

export interface VerifyResult {
  ok: boolean;
  /** Rows checked. */
  checked: number;
  /** Seq of the first row that fails. */
  brokenAt?: number;
}

export interface VerifyOptions {
  env?: Env;
  /** A head saved earlier (from `chainHead`), e.g. in another system. Detects deleted tail rows. */
  head?: { seq: number; hash: string };
  pageSize?: number;
}

/**
 * Re-computes every hash and link. Detects edited rows, deleted or reordered rows, and a deleted
 * prefix without a matching checkpoint. A deleted tail is only detectable against a saved `head`.
 */
export async function verifyChain(store: AuditStore, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const env = opts.env ?? {};
  const pageSize = opts.pageSize ?? 500;
  const anchors = new Map<number, string>();
  let first: AuditRecord | null = null;
  let prev: AuditRecord | null = null;
  let checked = 0;
  let after = 0;
  const broken = (seq: number): VerifyResult => ({ ok: false, checked, brokenAt: seq });
  for (;;) {
    const rows = await store.scan(after, pageSize, env);
    if (!rows.length) break;
    for (const row of rows) {
      if (!prev) {
        first = row;
        if (row.seq === 1 && row.prevHash !== GENESIS_HASH) return broken(row.seq);
      } else if (row.seq !== prev.seq + 1 || row.prevHash !== prev.hash) {
        return broken(row.seq);
      }
      if ((await hashRow(row.prevHash, row)) !== row.hash) return broken(row.seq);
      if (opts.head && row.seq === opts.head.seq && row.hash !== opts.head.hash) return broken(row.seq);
      if (row.action === CHECKPOINT_ACTION && row.resource === "audit" && row.metadata) {
        const { purgedThroughSeq, anchorHash } = row.metadata as { purgedThroughSeq?: unknown; anchorHash?: unknown };
        if (typeof purgedThroughSeq === "number" && typeof anchorHash === "string") anchors.set(purgedThroughSeq, anchorHash);
      }
      prev = row;
      checked++;
    }
    after = rows[rows.length - 1].seq;
  }
  if (first && first.seq !== 1 && anchors.get(first.seq - 1) !== first.prevHash) return { ok: false, checked, brokenAt: first.seq };
  if (opts.head && (!prev || prev.seq < opts.head.seq)) return { ok: false, checked, brokenAt: prev ? prev.seq + 1 : opts.head.seq };
  return { ok: true, checked };
}

/** The newest `{ seq, hash }`. Save it outside the database to detect truncation later. */
export async function chainHead(store: AuditStore, env: Env = {}): Promise<{ seq: number; hash: string } | null> {
  const h = await store.head(env);
  return h ? { seq: h.seq, hash: h.hash } : null;
}

const DAY = 86_400_000;

/**
 * Deletes rows older than `days` days, after verifying the chain, and appends a checkpoint row
 * recording where the chain now starts. Schedule it as a job:
 *
 * ```ts
 * app.on("scheduled", () => purgeOlderThan(store, 365 * 6))
 * ```
 */
export async function purgeOlderThan(store: AuditStore, days: number, opts: { env?: Env; now?: number } = {}): Promise<{ purged: number; checkpoint?: number }> {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
    throw errors.config("MIU_E_AUDIT_RETENTION_INVALID", `Invalid retention: ${days} days`, "Pass a finite number of days ≥ 0, e.g. purgeOlderThan(store, 365 * 6).");
  }
  const env = opts.env ?? {};
  const now = opts.now ?? Date.now();
  const cutoff = now - days * DAY;
  const head = await store.head(env);
  if (!head) return { purged: 0 };
  const [oldest] = await store.scan(0, 1, env);
  const fresh = await store.firstSeqSince(cutoff, env);
  const through = fresh === null ? head.seq : fresh - 1;
  if (!oldest || through < oldest.seq) return { purged: 0 };
  const check = await verifyChain(store, { env });
  if (!check.ok) {
    throw errors.custom({
      code: "MIU_E_AUDIT_CHAIN_BROKEN",
      status: 500,
      message: `Audit chain is broken at seq ${check.brokenAt}; refusing to purge`,
      fix: "Investigate with verifyChain(store) before deleting anything: purging now could hide tampering.",
      details: check,
    });
  }
  const [anchor] = await store.scan(through - 1, 1, env);
  if (!anchor || anchor.seq !== through) throw errors.internal("Audit row to anchor the purge is missing");
  const cp = await store.append(
    {
      ts: now,
      action: CHECKPOINT_ACTION,
      resource: "audit",
      metadata: { purgedThroughSeq: through, anchorHash: anchor.hash, purgedCount: through - oldest.seq + 1, purgedBefore: cutoff },
    },
    env,
  );
  const purged = await store.deleteThrough(through, env);
  return { purged, checkpoint: cp.seq };
}
