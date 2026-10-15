import { errors, type CloudflareNeeds, type Env } from "miujs";

/** What a server-side store keeps per session id. */
export interface SessionRecord {
  /** Data. */
  d: Record<string, unknown>;
  /** Flash values to show on the next request. */
  f?: Record<string, unknown>;
  /** Expiry, epoch milliseconds. */
  e: number;
}

/**
 * Server-side session storage. With a store, the cookie holds only the signed session id.
 * `env` is the request env, so stores can find Workers bindings per request.
 */
export interface SessionStore {
  readonly kind: string;
  get(id: string, env: Env): Promise<SessionRecord | null>;
  set(id: string, record: SessionRecord, ttlSeconds: number, env: Env): Promise<void>;
  delete(id: string, env: Env): Promise<void>;
  inspect?(): Record<string, unknown>;
  cloudflare?(): CloudflareNeeds;
}

// ---------------------------------------------------------------------------------------------

/** In-process store. Sessions are lost on restart and not shared between instances; for dev and tests. */
export function memorySessionStore(): SessionStore & { readonly size: number } {
  const map = new Map<string, SessionRecord>();
  return {
    kind: "memory",
    get size() {
      return map.size;
    },
    async get(id) {
      const r = map.get(id);
      if (!r) return null;
      if (r.e <= Date.now()) {
        map.delete(id);
        return null;
      }
      return structuredClone(r);
    },
    async set(id, record) {
      map.set(id, structuredClone(record));
    },
    async delete(id) {
      map.delete(id);
    },
    inspect: () => ({ store: "memory" }),
  };
}

// ---------------------------------------------------------------------------------------------

/** The part of Cloudflare's `KVNamespace` the store uses. */
export interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

const KV_PREFIX = "miu_session:";

/** Cloudflare KV. Pass the binding, or its name to read it from `ctx.env` per request. */
export function kvSessionStore(binding: KVLike | string): SessionStore {
  const resolve = (env: Env): KVLike => {
    if (typeof binding !== "string") return binding;
    const kv = env?.[binding] as KVLike | undefined;
    if (!kv || typeof kv.get !== "function") {
      throw errors.config(
        "MIU_E_SESSION_KV_MISSING",
        `No KV binding named "${binding}" in env`,
        `Add a [[kv_namespaces]] entry with binding = "${binding}" to wrangler.toml (or run \`miu deploy cloudflare\`).`,
      );
    }
    return kv;
  };
  return {
    kind: "kv",
    async get(id, env) {
      const r = (await resolve(env).get(KV_PREFIX + id, "json")) as SessionRecord | null;
      if (!r || typeof r !== "object" || r.e <= Date.now()) return null;
      return r;
    },
    async set(id, record, ttl, env) {
      // KV's minimum TTL is 60 seconds; expiry is also checked on read.
      await resolve(env).put(KV_PREFIX + id, JSON.stringify(record), { expirationTtl: Math.max(60, Math.ceil(ttl)) });
    },
    async delete(id, env) {
      await resolve(env).delete(KV_PREFIX + id);
    },
    inspect: () => ({ store: "kv", binding: typeof binding === "string" ? binding : "(binding)" }),
    cloudflare: () => (typeof binding === "string" ? { kv: [binding] } : {}),
  };
}

// ---------------------------------------------------------------------------------------------

// Structural copies of @miujs/db's types, so this package does not depend on it.
interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run(): Promise<unknown>;
}
interface DbLike {
  prepare(sql: string): DbStatement;
  exec(sql: string): Promise<unknown>;
}
type DbSource = DbLike | { binding: string; resolve(env: Env): DbLike };

/** SQL: a `miu_sessions` table in any @miujs/db database (SQLite locally, D1 on Workers). */
export function dbSessionStore(database: DbSource, opts: { table?: string } = {}): SessionStore {
  const table = opts.table ?? "miu_sessions";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw errors.config("MIU_E_SESSION_TABLE_INVALID", `Invalid table name "${table}"`, "Use letters, digits and underscores.");
  const ready = new WeakMap<DbLike, Promise<unknown>>();
  const get = async (env: Env): Promise<DbLike> => {
    const d = "prepare" in database ? database : database.resolve(env);
    let p = ready.get(d);
    if (!p) {
      p = d.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)`);
      p.catch(() => ready.delete(d));
      ready.set(d, p);
    }
    await p;
    return d;
  };
  return {
    kind: "db",
    async get(id, env) {
      const d = await get(env);
      const row = await d.prepare(`SELECT data, expires FROM ${table} WHERE id = ?`).bind(id).first<{ data: string; expires: number }>();
      if (!row) return null;
      if (row.expires <= Date.now()) {
        await d.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
        return null;
      }
      return JSON.parse(row.data) as SessionRecord;
    },
    async set(id, record, _ttl, env) {
      const d = await get(env);
      await d
        .prepare(`INSERT INTO ${table} (id, data, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires = excluded.expires`)
        .bind(id, JSON.stringify(record), record.e)
        .run();
    },
    async delete(id, env) {
      const d = await get(env);
      await d.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    },
    inspect: () => ({ store: "db", table, ...("prepare" in database ? {} : { binding: database.binding }) }),
    cloudflare: () => ("prepare" in database ? {} : { d1: [database.binding] }),
  };
}
