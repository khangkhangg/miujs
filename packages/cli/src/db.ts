// `miu db pull` and `miu db migrate`: local SQLite files through @miujs/db's sqlite(), remote D1
// through `wrangler d1 execute --remote --json` behind a D1-shaped adapter.

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateDrizzleSchema, introspect, loadMigrations, migrate, splitSql, sqlite, type D1Result, type Database, type Statement } from "@miujs/db";
import { BUNX, CliError, str, writeFile, type CliIO, type Flags, type Runner } from "./util.ts";

// ---------------------------------------------------------------------------------------------
// D1 over wrangler

/** Inlines `?` / `?N` parameters as SQL literals (wrangler's --command takes no bindings). Skips quoted text. */
export function inlineParams(sql: string, values: unknown[]): string {
  if (!values.length) return sql;
  const lit = (v: unknown): string => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "boolean") return v ? "1" : "0";
    if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
      const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
      return `X'${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
    }
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  let out = "";
  let next = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = sql.indexOf(c, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "?") {
      const m = /^\d+/.exec(sql.slice(i + 1));
      const index = m ? Number(m[0]) - 1 : next++;
      out += lit(values[index]);
      if (m) i += m[0].length;
    } else out += c;
  }
  return out;
}

/**
 * A `Database` for a remote D1 database, run through `wrangler d1 execute <name> --remote --json
 * --command "<sql>"`. Each call spawns wrangler, so it is slow but needs nothing but a login.
 * `batch()` sends all statements in one command.
 */
export function wranglerD1(name: string, run: Runner, cwd: string, opts: { local?: boolean } = {}): Database {
  const execute = async (sql: string): Promise<D1Result[]> => {
    const cmd = [...BUNX(), "wrangler", "d1", "execute", name, opts.local ? "--local" : "--remote", "--json", "--command", sql];
    const r = await run(cmd, { cwd });
    if (r.code !== 0) {
      throw new CliError(
        "MIU_E_CLI_WRANGLER",
        `wrangler d1 execute ${name} failed: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`,
        `Run \`bunx wrangler login\`, and check that "${name}" is the database_name of a [[d1_databases]] entry in wrangler.toml (\`bunx wrangler d1 list\`).`,
      );
    }
    const text = r.stdout.slice(Math.max(0, r.stdout.indexOf("[")));
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new CliError("MIU_E_CLI_WRANGLER", `wrangler d1 execute ${name} printed something that is not JSON: ${r.stdout.slice(0, 300)}`, "Update wrangler (`bunx wrangler --version` should be 3.x or newer) and try again.");
    }
  };
  const statement = (sql: string, values: unknown[]): Statement & { sql: string; values: unknown[] } => ({
    sql,
    values,
    bind: (...v: unknown[]) => statement(sql, v),
    async first(column?: string): Promise<any> {
      const [res] = await execute(inlineParams(sql, values));
      const row = res?.results?.[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return column === undefined ? row : row[column];
    },
    async all(): Promise<any> {
      const results = await execute(inlineParams(sql, values));
      return results[results.length - 1];
    },
    async run(): Promise<any> {
      const results = await execute(inlineParams(sql, values));
      return results[results.length - 1];
    },
    async raw(o?: { columnNames?: boolean }): Promise<any[]> {
      const [res] = await execute(inlineParams(sql, values));
      const rows = (res?.results ?? []) as Record<string, unknown>[];
      const names = rows[0] ? Object.keys(rows[0]) : [];
      const arrays = rows.map((r) => names.map((n) => r[n]));
      return o?.columnNames ? [names, ...arrays] : arrays;
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      const sql = statements.map((s) => {
        const st = s as unknown as { sql: string; values: unknown[] };
        return inlineParams(st.sql, st.values).trim().replace(/;$/, "");
      });
      return (await execute(sql.join(";\n") + ";")) as any;
    },
    async exec(sql) {
      const start = performance.now();
      const parts = splitSql(sql);
      if (parts.length) await execute(parts.join(";\n") + ";");
      return { count: parts.length, duration: performance.now() - start };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// local SQLite that can be closed (@miujs/db's sqlite() keeps its handle open for the process,
// which locks the file on Windows while `runCli` runs inside a longer-lived process)

interface BunStmt {
  all(...p: unknown[]): any[];
  values(...p: unknown[]): unknown[][];
  get(...p: unknown[]): any;
  run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  readonly columnNames: string[];
  finalize(): void;
}
interface BunDb {
  prepare(sql: string): BunStmt;
  run(sql: string): unknown;
  transaction<F extends (...a: any[]) => any>(fn: F): F;
  close(): void;
}

const bind = (values: unknown[]) => values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v instanceof ArrayBuffer ? new Uint8Array(v) : v));
const isQuery = (sql: string) => /^\s*(select|with|pragma|values)\b/i.test(sql) || /\breturning\b/i.test(sql);

export async function localSqlite(file: string): Promise<Database & { close(): void }> {
  const mod = "bun:sqlite";
  const { Database: BunDatabase } = (await import(/* @vite-ignore */ mod)) as { Database: new (p: string, o?: unknown) => BunDb };
  const handle = new BunDatabase(file, { create: true });
  handle.run("PRAGMA foreign_keys = ON");
  // Statements are finalized right away: an unfinalized one keeps the file open after close().
  const use = <T>(sql: string, fn: (s: BunStmt) => T): T => {
    const stmt = handle.prepare(sql);
    try {
      return fn(stmt);
    } finally {
      stmt.finalize();
    }
  };
  const one = (sql: string, values: unknown[], mode: "all" | "run"): D1Result<any> => {
    const start = performance.now();
    if (mode === "all") return { results: use(sql, (s) => s.all(...bind(values))), success: true, meta: { changes: 0, last_row_id: 0, duration: performance.now() - start } };
    const r = use(sql, (s) => s.run(...bind(values)));
    return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), duration: performance.now() - start } };
  };
  const statement = (sql: string, values: unknown[]): Statement & { sql: string; values: unknown[] } => ({
    sql,
    values,
    bind: (...v: unknown[]) => statement(sql, v),
    async first(column?: string): Promise<any> {
      const row = use(sql, (s) => s.get(...bind(values)));
      if (row === null || row === undefined) return null;
      return column === undefined ? row : row[column];
    },
    all: async (): Promise<any> => one(sql, values, "all"),
    run: async (): Promise<any> => one(sql, values, "run"),
    async raw(o?: { columnNames?: boolean }): Promise<any[]> {
      return use(sql, (stmt) => {
        const rows = stmt.values(...bind(values));
        return o?.columnNames ? [stmt.columnNames, ...rows] : rows;
      });
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      const list = statements as unknown as { sql: string; values: unknown[] }[];
      return handle.transaction(() => list.map((s) => one(s.sql, s.values, isQuery(s.sql) ? "all" : "run")))() as any;
    },
    async exec(sql) {
      const start = performance.now();
      const parts = splitSql(sql);
      for (const p of parts) handle.run(p);
      return { count: parts.length, duration: performance.now() - start };
    },
    close: () => handle.close(),
  };
}

// ---------------------------------------------------------------------------------------------
// choosing a database

function localFile(io: CliIO, given: string | undefined, mustExist: boolean): string {
  if (given) {
    const file = resolve(io.cwd, given);
    if (mustExist && !existsSync(file)) {
      throw new CliError("MIU_E_CLI_DB_NOT_FOUND", `Database file ${given} does not exist`, "Pass the path of your local SQLite file with --db, or --d1 <database-name> for a remote D1 database.");
    }
    return file;
  }
  const found = readdirSync(io.cwd).filter((f) => /\.(sqlite3?|db)$/i.test(f));
  if (found.length === 1) return join(io.cwd, found[0]);
  throw new CliError(
    "MIU_E_CLI_DB_SOURCE",
    found.length ? `Several database files here (${found.join(", ")}); which one?` : "No database given",
    "Pass --db <file.sqlite> for a local SQLite file, or --d1 <database-name> for a remote Cloudflare D1 database (uses `bunx wrangler d1 execute --remote`).",
  );
}

interface Opened {
  database: Database;
  label: string;
  close(): void;
}

async function openDatabase(io: CliIO, flags: Flags, run: Runner, mustExist: boolean): Promise<Opened> {
  const d1Name = str(flags, "d1");
  if (d1Name) return { database: wranglerD1(d1Name, run, io.cwd), label: `D1 ${d1Name} (remote)`, close() {} };
  const file = localFile(io, str(flags, "db"), mustExist);
  const database = await localSqlite(file);
  return { database, label: relative(io.cwd, file) || file, close: () => database.close() };
}

async function withDatabase<T>(io: CliIO, flags: Flags, run: Runner, mustExist: boolean, fn: (o: Opened) => Promise<T>): Promise<T> {
  const opened = await openDatabase(io, flags, run, mustExist);
  try {
    return await fn(opened);
  } finally {
    opened.close();
  }
}

// ---------------------------------------------------------------------------------------------
// commands

export async function cmdDbPull(io: CliIO, flags: Flags, run: Runner) {
  const { desc, label } = await withDatabase(io, flags, run, true, async ({ database, label }) => ({ desc: await introspect(database), label }));
  const out = str(flags, "out");
  if (flags.json) {
    const json = JSON.stringify(desc, null, 2);
    if (out) {
      writeFile(resolve(io.cwd, out), json + "\n");
      io.out(`Wrote ${out} (${desc.tables.length} tables from ${label})`);
    } else io.out(json);
    return 0;
  }
  const file = resolve(io.cwd, out ?? "schema.ts");
  writeFile(file, generateDrizzleSchema(desc));
  io.out(`Wrote ${relative(io.cwd, file)} (${desc.tables.length} tables from ${label})`);
  io.out("Next: import it in your app (db({ drizzle: { schema } })) and use `miu db migrate --generate <name> --schema " + relative(io.cwd, file).replace(/\\/g, "/") + "` for changes.");
  return 0;
}

const IS_TABLE = Symbol.for("drizzle:IsDrizzleTable");

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "migration";
}

async function generate(io: CliIO, flags: Flags, run: Runner, dir: string) {
  const name = str(flags, "generate")!;
  const schemaPath = str(flags, "schema");
  if (!schemaPath) {
    throw new CliError("MIU_E_CLI_DB_USAGE", "--generate needs the schema to compare against", "Pass --schema <file.ts> (the module that exports your Drizzle sqliteTable()s), e.g. `miu db migrate --generate add_posts --schema db/schema.ts`.");
  }
  const schemaFile = resolve(io.cwd, schemaPath);
  if (!existsSync(schemaFile)) throw new CliError("MIU_E_CLI_SCHEMA_NOT_FOUND", `Schema file ${schemaPath} does not exist`, "Pass the path of the module that exports your Drizzle tables with --schema.");

  let diffSchema: typeof import("@miujs/db/drizzle").diffSchema;
  try {
    ({ diffSchema } = await import("@miujs/db/drizzle"));
  } catch (err) {
    throw new CliError("MIU_E_CLI_DRIZZLE_MISSING", `Could not load drizzle-orm: ${(err as Error)?.message ?? err}`, "Install it in your app: `bun add drizzle-orm`.");
  }
  const mod = (await import(pathToFileURL(schemaFile).href)) as Record<string, unknown>;
  const tables = Object.values(mod).filter((v) => typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[IS_TABLE] === true);
  if (!tables.length) {
    throw new CliError("MIU_E_CLI_SCHEMA_EMPTY", `${schemaPath} exports no Drizzle tables`, "Export your tables from it: `export const users = sqliteTable(\"users\", { ... })`.");
  }

  // The "current" schema: the database you point at, or else the existing migrations replayed in memory.
  let current;
  let against: string;
  if (str(flags, "db") || str(flags, "d1")) {
    ({ current, against } = await withDatabase(io, flags, run, false, async ({ database, label }) => ({ current: await introspect(database), against: label })));
  } else {
    const scratch = sqlite(":memory:");
    const existing = existsSync(dir) ? await loadMigrations(dir) : [];
    await migrate(scratch, existing);
    current = await introspect(scratch);
    against = `${existing.length} migration(s) in ${relative(io.cwd, dir) || "."}`;
  }

  const diff = diffSchema(current, tables as never[]);
  for (const w of diff.warnings) io.out(`warn  ${w.kind} ${w.message}${w.sql ? `\n      by hand, after review: ${w.sql};` : ""}`);
  if (!diff.statements.length) {
    io.out(`Schema is up to date with ${against}; no migration written.`);
    return 0;
  }
  const numbers = existsSync(dir) ? readdirSync(dir).map((f) => /^(\d+)_.*\.sql$/i.exec(f)).filter((m) => m !== null) : [];
  const next = numbers.reduce((max, m) => Math.max(max, Number(m![1])), 0) + 1;
  const width = Math.max(4, ...numbers.map((m) => m![1].length));
  const fileName = `${String(next).padStart(width, "0")}_${slug(name)}.sql`;
  const file = join(dir, fileName);
  const header = [`-- Generated by \`miu db migrate --generate\` from ${schemaPath.replace(/\\/g, "/")} (compared with ${against}).`, "-- Review before applying. Destructive changes are listed at the end, commented out."];
  const manual = diff.warnings.length
    ? ["", "-- Not generated (would drop or rewrite data). Run by hand after review:", ...diff.warnings.flatMap((w) => [`-- ${w.message}`, ...(w.sql ? [`-- ${w.sql};`] : [])])]
    : [];
  writeFile(file, [...header, "", diff.sql, ...manual, ""].join("\n"));
  io.out(`Wrote ${relative(io.cwd, file).replace(/\\/g, "/")} (${diff.statements.length} statement(s))`);
  if (diff.warnings.length) io.out(`${diff.warnings.length} warning(s) above need a human: they are destructive and were not generated.`);
  io.out("Next: `miu db migrate` to apply it.");
  return 0;
}

export async function cmdDbMigrate(io: CliIO, flags: Flags, run: Runner) {
  const dir = resolve(io.cwd, str(flags, "dir") ?? "migrations");
  if (str(flags, "generate")) return generate(io, flags, run, dir);
  if (str(flags, "schema")) throw new CliError("MIU_E_CLI_DB_USAGE", "--schema is only used with --generate", "Run `miu db migrate --generate <name> --schema <file.ts>` to write a migration, or drop --schema to apply migrations.");
  const migrations = await loadMigrations(dir);
  if (!migrations.length) {
    io.out(`No NNNN_name.sql files in ${relative(io.cwd, dir) || "."}; nothing to apply.`);
    return 0;
  }
  const { applied, label } = await withDatabase(io, flags, run, false, async ({ database, label }) => ({ applied: await migrate(database, migrations), label }));
  for (const id of applied) io.out(`applied ${id}`);
  io.out(applied.length ? `${applied.length} migration(s) applied to ${label}.` : `${label} is up to date (${migrations.length} migration(s) already applied).`);
  return 0;
}

export async function cmdDb(io: CliIO, positional: string[], flags: Flags, run: Runner) {
  const sub = positional[0];
  if (sub === "pull") return cmdDbPull(io, flags, run);
  if (sub === "migrate") return cmdDbMigrate(io, flags, run);
  throw new CliError("MIU_E_CLI_DB_USAGE", `Unknown db command "${sub ?? ""}"`, "Use `miu db pull [--db file | --d1 name]` or `miu db migrate [--dir migrations] [--db file | --d1 name]`.");
}
