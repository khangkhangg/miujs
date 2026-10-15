import { schemaSql, sqlRepository, type SqlRepositoryOptions } from "../../batteries/data/sql.ts";
import type { Doc, Repository } from "../../batteries/data/types.ts";
import { resolveBinding, type BindingRef, type D1Database } from "./types.ts";

export type D1RepositoryOptions<T> = SqlRepositoryOptions<T>;

/**
 * Repository of JSON documents in Cloudflare D1: the scale-out driver for the admin and tour kits.
 * Same table layout as `sqliteRepository` (`miujs/sqlite`). `db` may be a getter such as `() => env.DB`.
 */
export function d1Repository<T extends Doc>(db: BindingRef<D1Database>, opts: D1RepositoryOptions<T>): Repository<T> {
  const ddl = schemaSql(opts.table, opts.indexes);
  const d = () => resolveBinding(db);
  return sqlRepository<T>(
    {
      all: async (sql, params) => (await d().prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
      first: async (sql, params) => (await d().prepare(sql).bind(...params).first<Record<string, unknown>>()) ?? undefined,
      run: async (sql, params) => void (await d().prepare(sql).bind(...params).run()),
    },
    async () => {
      const x = d();
      await x.batch(ddl.map((sql) => x.prepare(sql)));
    },
    opts,
  );
}
