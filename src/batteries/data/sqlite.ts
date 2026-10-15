import { openDatabase, type SqliteDatabase, type SqliteStatement } from "../sqlite.ts";
import { schemaSql, sqlRepository, type SqlRepositoryOptions } from "./sql.ts";
import type { Doc, Repository } from "./types.ts";

export interface SqliteRepositoryOptions<T> extends SqlRepositoryOptions<T> {
  /** Use an already-open database (shared with `sqliteStore` etc.). */
  db?: SqliteDatabase;
  /** Database file, or ":memory:", when `db` is not given. Default "miu.sqlite". */
  path?: string;
}

/**
 * Repository of JSON documents in SQLite (bun:sqlite or node:sqlite): the single-node default for the admin
 * and tour kits. Same table layout as `d1Repository`, so data moves between them unchanged.
 */
export function sqliteRepository<T extends Doc>(opts: SqliteRepositoryOptions<T>): Repository<T> {
  let db: SqliteDatabase | undefined = opts.db;
  const stmts = new Map<string, SqliteStatement>();
  const st = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = db!.prepare(sql);
      if (stmts.size > 200) stmts.clear();
      stmts.set(sql, s);
    }
    return s;
  };
  const ddl = schemaSql(opts.table, opts.indexes);
  return sqlRepository<T>(
    {
      all: async (sql, params) => st(sql).all(...params) as Record<string, unknown>[],
      first: async (sql, params) => (st(sql).get(...params) ?? undefined) as Record<string, unknown> | undefined,
      run: async (sql, params) => void st(sql).run(...params),
    },
    async () => {
      db ??= await openDatabase(opts.path ?? "miu.sqlite");
      for (const sql of ddl) db.exec(sql);
    },
    opts,
  );
}
