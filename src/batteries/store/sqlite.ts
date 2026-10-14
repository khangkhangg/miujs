import { openDatabase, type SqliteDatabase } from "../sqlite.ts";
import { prefixed, remainingSeconds, type Store } from "./types.ts";

export interface SqliteStoreOptions {
  /** Database file, or ":memory:". Default "miu.sqlite". */
  path?: string;
  /** Use an already-open database instead of `path`. */
  db?: SqliteDatabase;
  /** Table name. Default "miu_kv". */
  table?: string;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

/**
 * SQLite-backed store: the default for single-server apps. Durable, shared
 * across processes on the same machine, and needs no extra service.
 */
export function sqliteStore(opts: SqliteStoreOptions = {}): Store {
  const now = opts.now ?? Date.now;
  const table = opts.table ?? "miu_kv";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`);

  let writes = 0;
  const ready = (async () => {
    const db = opts.db ?? (await openDatabase(opts.path ?? "miu.sqlite"));
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_expires ON ${table}(expires) WHERE expires IS NOT NULL`);
    return {
      db,
      get: db.prepare(`SELECT value, expires FROM ${table} WHERE key = ? AND (expires IS NULL OR expires > ?)`),
      set: db.prepare(
        `INSERT INTO ${table} (key, value, expires) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires`,
      ),
      del: db.prepare(`DELETE FROM ${table} WHERE key = ? RETURNING expires`),
      incr: db.prepare(
        `INSERT INTO ${table} (key, value, expires) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = CASE WHEN expires IS NOT NULL AND expires <= ?4 THEN excluded.value ELSE CAST(value AS INTEGER) + ?2 END,
           expires = CASE WHEN expires IS NOT NULL AND expires <= ?4 THEN excluded.expires ELSE expires END
         RETURNING value`,
      ),
      sweep: db.prepare(`DELETE FROM ${table} WHERE expires IS NOT NULL AND expires <= ?`),
    };
  })();

  const maybeSweep = (s: Awaited<typeof ready>) => {
    if (++writes % 1000 === 0) s.sweep.run(now());
  };
  const expiry = (ttl?: number) => (ttl ? now() + ttl * 1000 : null);

  const store: Store = {
    async get<T>(key: string) {
      const s = await ready;
      const row = s.get.get(key, now()) as { value: string } | undefined;
      return row ? (JSON.parse(String(row.value)) as T) : undefined;
    },
    async set(key, value, o) {
      const s = await ready;
      s.set.run(key, JSON.stringify(value), expiry(o?.ttl));
      maybeSweep(s);
    },
    async delete(key) {
      const s = await ready;
      const row = s.del.get(key) as { expires: number | null } | undefined;
      return row !== undefined && (row.expires === null || row.expires > now());
    },
    async has(key) {
      const s = await ready;
      return s.get.get(key, now()) !== undefined;
    },
    async incr(key, by = 1, o) {
      const s = await ready;
      const row = s.incr.get(key, by, expiry(o?.ttl), now()) as { value: number | string };
      maybeSweep(s);
      return Number(row.value);
    },
    async ttl(key) {
      const s = await ready;
      const row = s.get.get(key, now()) as { expires: number | null } | undefined;
      return row ? remainingSeconds(row.expires, now()) : undefined;
    },
    prefix: (p) => prefixed(store, p),
    async close() {
      const s = await ready;
      if (!opts.db) s.db.close();
    },
  };
  return store;
}
