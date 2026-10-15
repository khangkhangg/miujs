// A D1-shaped database over node:sqlite (Node 24, Deno 2), so @miujs/db and @miujs/auth's
// dbUserStore run outside Bun. @miujs/db's own sqlite() uses bun:sqlite and is Bun-only.
// Copied into the temp consumer projects by scripts/release/verify.ts; not part of any package.
import type { D1Result, Database, Statement } from "@miujs/db";

interface SyncStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SyncDatabase {
  prepare(sql: string): SyncStatement;
  exec(sql: string): void;
}

const value = (v: unknown): unknown => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

export async function nodeSqliteD1(path = ":memory:"): Promise<Database> {
  const mod = "node:sqlite";
  const { DatabaseSync } = (await import(mod)) as { DatabaseSync: new (p: string) => SyncDatabase };
  const db = new DatabaseSync(path);
  const result = <T>(results: T[], changes = 0, last = 0): D1Result<T> => ({ results, success: true, meta: { changes, last_row_id: last, duration: 0 } });

  const statement = (sql: string, params: unknown[]): Statement => {
    const isRead = /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
    const exec = <T>(): D1Result<T> => {
      const s = db.prepare(sql);
      if (isRead) return result(s.all(...params) as T[]);
      const r = s.run(...params);
      return result<T>([], Number(r.changes), Number(r.lastInsertRowid));
    };
    const stmt = {
      bind: (...values: unknown[]) => statement(sql, values.map(value)),
      async first(column?: string) {
        const row = (db.prepare(sql).all(...params)[0] ?? null) as Record<string, unknown> | null;
        return row === null ? null : column === undefined ? row : (row[column] ?? null);
      },
      all: async () => exec(),
      run: async () => exec(),
      async raw(options?: { columnNames?: boolean }) {
        const rows = db.prepare(sql).all(...params);
        const out: unknown[][] = rows.map((r) => Object.values(r));
        if (options?.columnNames) out.unshift(rows[0] ? Object.keys(rows[0]) : []);
        return out;
      },
      _run: exec,
    };
    return stmt as unknown as Statement;
  };

  return {
    prepare: (sql: string) => statement(sql, []),
    async batch<T>(statements: Statement[]): Promise<D1Result<T>[]> {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => (s as unknown as { _run: () => D1Result<T> })._run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: sql.split(";").filter((s) => s.trim()).length, duration: 0 };
    },
  };
}
