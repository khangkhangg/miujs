// Vector stores for RAG. One interface, three adapters: in-memory, SQLite/D1 (brute-force cosine
// over float32 blobs, fine for a few thousand vectors) and Cloudflare Vectorize.

import type { Env } from "miujs";
import { aiErrors } from "./errors.ts";

export interface VectorRecord {
  id: string;
  values: number[];
  /** Stored with the vector. RAG keeps the chunk's text in `metadata.text`. */
  metadata?: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity (Vectorize: the index's metric). Higher is closer. */
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorQuery {
  /** Default 4. */
  topK?: number;
  /** Metadata equality filter (`{ kind: "faq" }`). Vectorize needs a metadata index for it. */
  filter?: Record<string, unknown>;
}

export interface VectorStore {
  readonly name: string;
  upsert(records: VectorRecord[]): Promise<void>;
  query(vector: number[], opts?: VectorQuery): Promise<VectorMatch[]>;
  delete(ids: string[]): Promise<void>;
  /** For stores backed by a per-request binding: the store for this env. */
  forEnv?(env: Env): VectorStore;
  inspect?(): Record<string, unknown>;
}

export const DEFAULT_TOP_K = 4;

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function matches(meta: Record<string, unknown> | undefined, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) if (meta?.[k] !== v) return false;
  return true;
}

function topK(rows: Iterable<{ id: string; values: ArrayLike<number>; metadata?: Record<string, unknown> }>, vector: number[], opts: VectorQuery): VectorMatch[] {
  const out: VectorMatch[] = [];
  for (const r of rows) {
    if (!matches(r.metadata, opts.filter)) continue;
    const m: VectorMatch = { id: r.id, score: cosine(vector, r.values) };
    if (r.metadata) m.metadata = r.metadata;
    out.push(m);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, opts.topK ?? DEFAULT_TOP_K);
}

/** In-process vectors with cosine similarity. For tests and small, rebuildable sets. */
export function memoryVectors(): VectorStore {
  const rows = new Map<string, { id: string; values: Float32Array; metadata?: Record<string, unknown> }>();
  return {
    name: "memory",
    async upsert(records) {
      for (const r of records) rows.set(r.id, { id: r.id, values: Float32Array.from(r.values), ...(r.metadata ? { metadata: structuredClone(r.metadata) } : {}) });
    },
    async query(vector, opts = {}) {
      return topK(rows.values(), vector, opts);
    },
    async delete(ids) {
      for (const id of ids) rows.delete(id);
    },
    inspect: () => ({ adapter: "memory", size: rows.size }),
  };
}

// ---------------------------------------------------------------------------------------------
// SQLite / D1

/** The D1-compatible subset used here; `@miujs/db`'s `sqlite()` and a D1 binding both satisfy it. */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: unknown[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}

/** `@miujs/db`'s `d1("DB")`: a database found in the request env. */
interface SqlDatabaseRef {
  binding: string;
  resolve(env: Env): SqlDatabase;
}

function toFloats(blob: unknown): Float32Array {
  if (blob instanceof Float32Array) return blob;
  if (Array.isArray(blob)) blob = Uint8Array.from(blob);
  const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob) : (blob as Uint8Array);
  // Copy so the floats are 4-byte aligned whatever the driver's buffer offset.
  return new Float32Array(bytes.slice().buffer, 0, Math.floor(bytes.byteLength / 4));
}

/**
 * Vectors in a SQLite/D1 table as float32 blobs, searched by brute-force cosine. Good for small
 * sets (thousands of chunks); use `vectorize()` beyond that.
 */
export function sqliteVectors(db: SqlDatabase | SqlDatabaseRef, opts: { table?: string } = {}): VectorStore {
  const table = opts.table ?? "miu_vectors";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw aiErrors.config(`Invalid vector table name ${JSON.stringify(table)}`, "Use letters, digits and underscores, starting with a letter or underscore.");
  }
  if (typeof (db as SqlDatabaseRef).resolve === "function") {
    const ref = db as SqlDatabaseRef;
    const store = (env: Env) => sqliteVectors(ref.resolve(env), opts);
    return {
      name: "sqlite",
      upsert: () => Promise.reject(unbound(ref.binding)),
      query: () => Promise.reject(unbound(ref.binding)),
      delete: () => Promise.reject(unbound(ref.binding)),
      forEnv: store,
      inspect: () => ({ adapter: "sqlite", table, binding: ref.binding }),
    };
  }
  const sql = db as SqlDatabase;
  let ready: Promise<unknown> | null = null;
  const ensure = () =>
    (ready ??= sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, dims INTEGER NOT NULL, embedding BLOB NOT NULL, metadata TEXT)`).catch((e) => {
      ready = null;
      throw e;
    }));
  return {
    name: "sqlite",
    async upsert(records) {
      if (!records.length) return;
      await ensure();
      const stmt = sql.prepare(
        `INSERT INTO ${table} (id, dims, embedding, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET dims = excluded.dims, embedding = excluded.embedding, metadata = excluded.metadata`,
      );
      await sql.batch(records.map((r) => stmt.bind(r.id, r.values.length, new Uint8Array(Float32Array.from(r.values).buffer), r.metadata ? JSON.stringify(r.metadata) : null)));
    },
    async query(vector, q = {}) {
      await ensure();
      const { results } = await sql.prepare(`SELECT id, embedding, metadata FROM ${table} WHERE dims = ?`).bind(vector.length).all<{ id: string; embedding: unknown; metadata: string | null }>();
      return topK(
        results.map((r) => ({ id: r.id, values: toFloats(r.embedding), ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}) })),
        vector,
        q,
      );
    },
    async delete(ids) {
      if (!ids.length) return;
      await ensure();
      const stmt = sql.prepare(`DELETE FROM ${table} WHERE id = ?`);
      await sql.batch(ids.map((id) => stmt.bind(id)));
    },
    inspect: () => ({ adapter: "sqlite", table }),
  };
}

function unbound(binding: string) {
  return aiErrors.config(
    `This vector store reads env.${binding} per request and was used without an env`,
    "Use it through ctx.ai (rag/index resolve it with the request env), or call store.forEnv(env) first.",
  );
}

// ---------------------------------------------------------------------------------------------
// Cloudflare Vectorize

/** The subset of Cloudflare's `VectorizeIndex` binding used here. */
export interface VectorizeIndexLike {
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]): Promise<unknown>;
  query(vector: number[], options: Record<string, unknown>): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

function vectorizeStore(index: VectorizeIndexLike): VectorStore {
  return {
    name: "vectorize",
    async upsert(records) {
      if (records.length) await index.upsert(records.map((r) => ({ id: r.id, values: r.values, ...(r.metadata ? { metadata: r.metadata } : {}) })));
    },
    async query(vector, opts = {}) {
      const o: Record<string, unknown> = { topK: opts.topK ?? DEFAULT_TOP_K, returnMetadata: "all" };
      if (opts.filter) o.filter = opts.filter;
      const res = await index.query(vector, o);
      return (res.matches ?? []).map((m) => ({ id: m.id, score: m.score, ...(m.metadata ? { metadata: m.metadata } : {}) }));
    },
    async delete(ids) {
      if (ids.length) await index.deleteByIds(ids);
    },
  };
}

/**
 * Cloudflare Vectorize. Pass the binding name (resolved from the request env) or the binding.
 * Needs `[[vectorize]] binding = "..." index_name = "..."` in wrangler.toml.
 */
export function vectorize(binding: string | VectorizeIndexLike = "VECTORIZE"): VectorStore {
  if (typeof binding !== "string") return { ...vectorizeStore(binding), inspect: () => ({ adapter: "vectorize" }) };
  const forEnv = (env: Env): VectorStore => {
    const index = env?.[binding] as VectorizeIndexLike | undefined;
    if (!index || typeof index.query !== "function") {
      const missing = aiErrors.binding(binding, "Vectorize", `Add [[vectorize]] binding = "${binding}" index_name = "<your index>" to wrangler.toml (create it with \`wrangler vectorize create\`). Locally, use memoryVectors() or sqliteVectors(db).`);
      return { name: "vectorize", upsert: () => Promise.reject(missing), query: () => Promise.reject(missing), delete: () => Promise.reject(missing) };
    }
    return vectorizeStore(index);
  };
  return {
    name: "vectorize",
    upsert: () => Promise.reject(unbound(binding)),
    query: () => Promise.reject(unbound(binding)),
    delete: () => Promise.reject(unbound(binding)),
    forEnv,
    inspect: () => ({ adapter: "vectorize", binding }),
  };
}
