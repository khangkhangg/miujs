import { errors, MiuError, type CloudflareNeeds, type Env } from "miujs";

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
  /** Live sessions, counting at most `max` (admin status). Memory and SQL stores. */
  count?(env: Env, max: number): Promise<number>;
  /** Pages through live sessions (admin list). Memory and SQL stores. */
  list?(q: SessionListQuery, env: Env): Promise<{ sessions: SessionInfo[]; next?: string }>;
  /** Deletes every session of this user (`data.userId`, compared as text); returns how many. */
  deleteUser?(userId: string, env: Env): Promise<number>;
}

/** The session data key that holds the signed-in user's id (set by @miujs/auth). */
export const SESSION_USER_KEY = "userId";

/** SQL for a stored session's user id as text (SQLite and D1 JSON functions). */
const USER_SQL = `CAST(json_extract(data, '$.d.${SESSION_USER_KEY}') AS TEXT)`;

export interface SessionListQuery {
  /** Opaque cursor from the previous page's `next`. */
  cursor?: string;
  limit: number;
  /** Only sessions of this user. */
  userId?: string;
}

/** A session as listed for the admin. `id` is a secret: callers must not show it. */
export interface SessionInfo {
  id: string;
  /** `data.userId` as text, or null when signed out. */
  userId: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

const userOf = (d: Record<string, unknown> | undefined): string | null => {
  const v = d?.[SESSION_USER_KEY];
  return v === undefined || v === null ? null : String(v);
};

// ---------------------------------------------------------------------------------------------

/**
 * In-process store. Sessions are lost on restart and not shared between instances; for dev and tests.
 * Expired sessions are swept whenever the store has doubled since the last sweep, so it holds at
 * most about twice the live sessions.
 */
export function memorySessionStore(opts: { now?: () => number } = {}): SessionStore & { readonly size: number } {
  const now = opts.now ?? Date.now;
  const map = new Map<string, SessionRecord>();
  let sweepAt = 64;
  const sweep = () => {
    const t = now();
    for (const [k, r] of map) if (r.e <= t) map.delete(k);
    sweepAt = Math.max(64, map.size * 2);
  };
  return {
    kind: "memory",
    get size() {
      return map.size;
    },
    async get(id) {
      const r = map.get(id);
      if (!r) return null;
      if (r.e <= now()) {
        map.delete(id);
        return null;
      }
      return structuredClone(r);
    },
    async set(id, record) {
      map.set(id, structuredClone(record));
      if (map.size >= sweepAt) sweep();
    },
    async delete(id) {
      map.delete(id);
    },
    async count(_env, max) {
      const t = now();
      let n = 0;
      for (const r of map.values()) if (r.e > t && ++n >= max) break;
      return n;
    },
    // Cursor = sessions already returned (Map order is insertion order; new logins append).
    async list(q) {
      const t = now();
      const skip = q.cursor ? Number(q.cursor) || 0 : 0;
      const sessions: SessionInfo[] = [];
      let seen = 0;
      for (const [id, r] of map) {
        if (r.e <= t) continue;
        const userId = userOf(r.d);
        if (q.userId !== undefined && userId !== q.userId) continue;
        if (seen++ < skip) continue;
        if (sessions.length === q.limit) return { sessions, next: String(skip + sessions.length) };
        sessions.push({ id, userId, expiresAt: r.e });
      }
      return { sessions };
    },
    async deleteUser(userId) {
      let n = 0;
      for (const [id, r] of map) {
        if (userOf(r.d) === userId) {
          map.delete(id);
          if (r.e > now()) n++;
        }
      }
      return n;
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
  /** D1 and @miujs/db have it; the admin list needs it. */
  all?<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
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
    async count(env, max) {
      const d = await get(env);
      return (await d.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE expires > ? LIMIT ?)`).bind(Date.now(), max).first<number>("n")) ?? 0;
    },
    // Paged by rowid, so the cursor never carries a session id.
    async list(q, env) {
      const d = await get(env);
      const after = q.cursor ? Number(q.cursor) || 0 : 0;
      const byUser = q.userId !== undefined ? ` AND ${USER_SQL} = ?` : "";
      const stmt = d
        .prepare(`SELECT rowid AS r, id, expires, ${USER_SQL} AS u FROM ${table} WHERE rowid > ? AND expires > ?${byUser} ORDER BY rowid LIMIT ?`)
        .bind(...[after, Date.now(), ...(q.userId !== undefined ? [q.userId] : []), q.limit + 1]);
      if (!stmt.all) throw errors.badRequest("This database client cannot list rows", "Use @miujs/db (sqlite() or d1()) for dbSessionStore.");
      const rows = (await stmt.all<{ r: number; id: string; expires: number; u: string | null }>()).results;
      const page = rows.slice(0, q.limit);
      const sessions = page.map((x) => ({ id: x.id, userId: x.u ?? null, expiresAt: Number(x.expires) }));
      return rows.length > q.limit ? { sessions, next: String(page[page.length - 1].r) } : { sessions };
    },
    async deleteUser(userId, env) {
      const d = await get(env);
      const n = (await d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${USER_SQL} = ? AND expires > ?`).bind(userId, Date.now()).first<number>("n")) ?? 0;
      await d.prepare(`DELETE FROM ${table} WHERE ${USER_SQL} = ?`).bind(userId).run();
      return n;
    },
    inspect: () => ({ store: "db", table, ...("prepare" in database ? {} : { binding: database.binding }) }),
    cloudflare: () => ("prepare" in database ? {} : { d1: [database.binding] }),
  };
}

// ---------------------------------------------------------------------------------------------

/** The Redis commands this store uses. `bunRedis()` from @miujs/cache satisfies it. */
export interface SessionRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { px?: number }): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  inspect?(): Record<string, unknown>;
}

/**
 * Redis: sessions shared by every instance, expired by Redis (`SET ... PX`) and checked on read.
 * `redisSessionStore(bunRedis())` on Bun (`bunRedis` is exported by @miujs/cache).
 */
export function redisSessionStore(client: SessionRedisLike, opts: { prefix?: string } = {}): SessionStore {
  const c = client as Partial<SessionRedisLike> | null;
  if (typeof c !== "object" || c === null || typeof c.get !== "function" || typeof c.set !== "function" || typeof c.del !== "function") {
    throw errors.config("MIU_E_SESSION_REDIS_CLIENT", "redisSessionStore needs a Redis client with get/set/del", "Pass bunRedis() from @miujs/cache on Bun, or any client wrapped with redisFromCommand(...).");
  }
  const prefix = opts.prefix ?? "miu:session:";
  const call = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new MiuError({
        code: "MIU_E_SESSION_REDIS",
        status: 500,
        message: `Redis ${op} for a session failed: ${String((err as Error)?.message ?? err)}`,
        fix: "Check that Redis is running and reachable at REDIS_URL (or the url passed to bunRedis()), with the right credentials and TLS settings.",
        cause: err,
      });
    }
  };
  return {
    kind: "redis",
    async get(id) {
      const text = await call("GET", () => client.get(prefix + id));
      if (text === null) return null;
      let r: SessionRecord | null;
      try {
        r = JSON.parse(text) as SessionRecord;
      } catch {
        return null; // foreign or corrupted value: treat as no session
      }
      if (!r || typeof r !== "object" || !(r.e > Date.now())) return null;
      return r;
    },
    async set(id, record, ttl) {
      await call("SET", () => client.set(prefix + id, JSON.stringify(record), { px: Math.max(1, Math.ceil(ttl * 1000)) }));
    },
    async delete(id) {
      await call("DEL", () => client.del(prefix + id));
    },
    inspect: () => ({ store: "redis", prefix, ...(client.inspect ? { client: client.inspect() } : {}) }),
    cloudflare: () => ({}),
  };
}
