/**
 * Minimal synchronous SQLite surface shared by `bun:sqlite` and `node:sqlite`,
 * so batteries work on both runtimes without a native dependency.
 */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Open a database file (or ":memory:") with whichever SQLite the runtime ships. */
export async function openDatabase(path = ":memory:"): Promise<SqliteDatabase> {
  let db: SqliteDatabase;
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    const raw = new Database(path, { create: true });
    db = {
      exec: (sql) => void raw.exec(sql),
      prepare: (sql) => {
        const st = raw.prepare(sql);
        return {
          run: (...p) => st.run(...(p as [])),
          // bun returns null for no row; normalize to undefined like node:sqlite
          get: (...p) => st.get(...(p as [])) ?? undefined,
          all: (...p) => st.all(...(p as [])),
        };
      },
      close: () => raw.close(),
    };
  } else {
    const mod = (await import("node:sqlite" as string)) as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    db = new mod.DatabaseSync(path);
  }
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
  }
  return db;
}
