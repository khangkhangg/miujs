import { prefixed, remainingSeconds, type Store } from "../../batteries/store/types.ts";
import { resolveBinding, type BindingRef, type D1Database } from "./types.ts";

export interface D1StoreOptions {
  /** Table name. Default "miu_kv". Created on first use. */
  table?: string;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

/**
 * Store over Cloudflare D1 (SQLite at the edge). Strongly consistent with an atomic
 * `incr`, so it suits sessions and rate limiting. Same schema as `sqliteStore`.
 * Expired rows are ignored on read and swept every 1000 writes.
 *
 * `db` may be a getter such as `() => env.DB` so the store can be created at module scope.
 */
export function d1Store(db: BindingRef<D1Database>, opts: D1StoreOptions = {}): Store {
  const now = opts.now ?? Date.now;
  const table = opts.table ?? "miu_kv";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`);

  const sql = {
    get: `SELECT value, expires FROM ${table} WHERE key = ? AND (expires IS NULL OR expires > ?)`,
    set: `INSERT INTO ${table} (key, value, expires) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires`,
    del: `DELETE FROM ${table} WHERE key = ? RETURNING expires`,
    incr: `INSERT INTO ${table} (key, value, expires) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET
             value = CASE WHEN expires IS NOT NULL AND expires <= ?4 THEN excluded.value ELSE CAST(value AS INTEGER) + ?2 END,
             expires = CASE WHEN expires IS NOT NULL AND expires <= ?4 THEN excluded.expires ELSE expires END
           RETURNING value`,
    sweep: `DELETE FROM ${table} WHERE expires IS NOT NULL AND expires <= ?`,
  };

  // Created once per isolate; retried on the next call if it failed.
  let ready: Promise<D1Database> | undefined;
  const init = () =>
    (ready ??= (async () => {
      const d = resolveBinding(db);
      await d.batch([
        d.prepare(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER)`),
        d.prepare(`CREATE INDEX IF NOT EXISTS ${table}_expires ON ${table}(expires) WHERE expires IS NOT NULL`),
      ]);
      return d;
    })().catch((e) => {
      ready = undefined;
      throw e;
    }));

  let writes = 0;
  const maybeSweep = async (d: D1Database) => {
    if (++writes % 1000 === 0) await d.prepare(sql.sweep).bind(now()).run();
  };
  const expiry = (ttl?: number) => (ttl ? now() + ttl * 1000 : null);
  const row = async (key: string) => {
    const d = await init();
    return d.prepare(sql.get).bind(key, now()).first<{ value: string; expires: number | null }>();
  };

  const store: Store = {
    async get<T>(key: string) {
      const r = await row(key);
      return r ? (JSON.parse(String(r.value)) as T) : undefined;
    },
    async set(key, value, o) {
      const d = await init();
      await d.prepare(sql.set).bind(key, JSON.stringify(value), expiry(o?.ttl)).run();
      await maybeSweep(d);
    },
    async delete(key) {
      const d = await init();
      const r = await d.prepare(sql.del).bind(key).first<{ expires: number | null }>();
      return r !== null && (r.expires === null || r.expires > now());
    },
    async has(key) {
      return (await row(key)) !== null;
    },
    async incr(key, by = 1, o) {
      const d = await init();
      const r = await d.prepare(sql.incr).bind(key, by, expiry(o?.ttl), now()).first<{ value: number | string }>();
      await maybeSweep(d);
      return Number(r!.value);
    },
    async ttl(key) {
      const r = await row(key);
      return r ? remainingSeconds(r.expires, now()) : undefined;
    },
    prefix: (p) => prefixed(store, p),
    async close() {},
  };
  return store;
}
