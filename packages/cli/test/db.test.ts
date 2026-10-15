import { afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitSql } from "@miujs/db";
import { cleanup, fakeRunner, linkWorkspace, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

const INIT = `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'member');
CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL);
CREATE INDEX posts_user ON posts(user_id);`;

/** Reads rows and closes the file again (unfinalized statements would keep it locked on Windows). */
function rows(file: string, sql: string) {
  const db = new BunDatabase(file);
  const stmt = db.prepare(sql);
  const out = stmt.all();
  stmt.finalize();
  db.close();
  return out;
}

function sqliteFile(dir: string, sql = INIT) {
  const file = join(dir, "app.sqlite");
  const db = new BunDatabase(file, { create: true });
  for (const s of splitSql(sql)) db.run(s);
  db.close();
  return file;
}

/** Answers `wrangler d1 execute --json --command` from a real local SQLite database, the way D1 would. */
function wranglerD1Fake(db: BunDatabase) {
  return fakeRunner((cmd) => {
    const sql = cmd[cmd.indexOf("--command") + 1];
    try {
      const out = splitSql(sql).map((s) => {
        const stmt = db.prepare(s);
        const isQuery = /^\s*(select|pragma|with|values)\b/i.test(s) || /\breturning\b/i.test(s);
        if (isQuery) return { results: stmt.all(), success: true, meta: { changes: 0, last_row_id: 0, duration: 0.1 } };
        const r = stmt.run();
        return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), duration: 0.1 } };
      });
      return { stdout: JSON.stringify(out, null, 2) };
    } catch (e) {
      return { code: 1, stderr: `✘ [ERROR] ${(e as Error).message}` };
    }
  });
}

describe("miu db pull", () => {
  test("introspects a SQLite file and writes a Drizzle schema", async () => {
    const dir = tempDir();
    sqliteFile(dir);
    const r = await run(["db", "pull", "--db", "app.sqlite", "--out", "db/schema.ts"], dir);
    expect(r.code).toBe(0);
    const src = readFileSync(join(dir, "db", "schema.ts"), "utf8");
    expect(src).toContain('export const users = sqliteTable("users"');
    expect(src).toContain('.references((): AnySQLiteColumn => users.id, { onDelete: "cascade" })');
    expect(src).toContain('index("posts_user")');
    expect(r.out).toContain("2 tables");
  });

  test("--json prints the schema description", async () => {
    const dir = tempDir();
    sqliteFile(dir);
    const r = await run(["db", "pull", "--db", "app.sqlite", "--json"], dir);
    expect(r.code).toBe(0);
    const desc = JSON.parse(r.out);
    expect(desc.tables.map((t: { name: string }) => t.name)).toEqual(["users", "posts"]);
  });

  test("finds the only .sqlite file in the folder when --db is left out", async () => {
    const dir = tempDir();
    sqliteFile(dir);
    const r = await run(["db", "pull", "--json"], dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).tables).toHaveLength(2);
  });

  test("a missing database file is a MIU_E_CLI_DB_NOT_FOUND error", async () => {
    const r = await run(["db", "pull", "--db", "nope.sqlite"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_DB_NOT_FOUND");
  });

  test("no database at all tells you about --db and --d1", async () => {
    const r = await run(["db", "pull"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_DB_SOURCE");
    expect(r.err).toContain("--d1");
  });

  test("--d1 reads a remote D1 database through wrangler d1 execute", async () => {
    const remote = new BunDatabase(":memory:");
    for (const s of splitSql(INIT)) remote.run(s);
    const { runner, calls } = wranglerD1Fake(remote);
    const dir = tempDir();
    const r = await run(["db", "pull", "--d1", "prod-db", "--json"], dir, runner);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).tables.map((t: { name: string }) => t.name)).toEqual(["users", "posts"]);
    expect(calls.length).toBeGreaterThan(0);
    const [first] = calls;
    expect(first.cmd.slice(first.cmd.indexOf("wrangler"), first.cmd.indexOf("--command"))).toEqual(["wrangler", "d1", "execute", "prod-db", "--remote", "--json"]);
    expect(first.opts.cwd).toBe(dir);
  });

  test("wrangler failures surface as MIU_E_CLI_WRANGLER with a fix", async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stderr: "Authentication error" }));
    const r = await run(["db", "pull", "--d1", "prod-db"], tempDir(), runner);
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_WRANGLER");
    expect(r.err).toContain("Authentication error");
    expect(r.err).toContain("wrangler login");
  });
});

function migrationsDir(dir: string, files: Record<string, string>) {
  const m = join(dir, "migrations");
  mkdirSync(m, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(m, name), sql);
  return m;
}

describe("miu db migrate", () => {
  test("applies NNNN_name.sql files to a SQLite file, once", async () => {
    const dir = tempDir();
    migrationsDir(dir, { "0001_init.sql": INIT, "0002_tags.sql": "CREATE TABLE tags (name TEXT PRIMARY KEY);" });
    const r = await run(["db", "migrate", "--db", "app.sqlite"], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("applied 0001_init");
    expect(r.out).toContain("applied 0002_tags");
    const again = await run(["db", "migrate", "--db", "app.sqlite"], dir);
    expect(again.code).toBe(0);
    expect(again.out).toContain("up to date");
    expect(rows(join(dir, "app.sqlite"), "SELECT id FROM _miu_migrations ORDER BY id")).toEqual([{ id: "0001_init" }, { id: "0002_tags" }]);
  });

  test("a failing migration exits 1 with the db error code", async () => {
    const dir = tempDir();
    migrationsDir(dir, { "0001_bad.sql": "CREATE TABLE x (;" });
    const r = await run(["db", "migrate", "--db", "app.sqlite"], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_DB_MIGRATION_FAILED");
  });

  test("--d1 applies migrations remotely through wrangler", async () => {
    const remote = new BunDatabase(":memory:");
    const { runner, calls } = wranglerD1Fake(remote);
    const dir = tempDir();
    migrationsDir(dir, { "0001_init.sql": INIT });
    const r = await run(["db", "migrate", "--d1", "prod-db"], dir, runner);
    expect(r.code).toBe(0);
    expect(r.out).toContain("applied 0001_init");
    expect(remote.prepare("SELECT id FROM _miu_migrations").all()).toEqual([{ id: "0001_init" }]);
    expect(remote.prepare("SELECT name FROM sqlite_master WHERE name = 'posts'").all()).toHaveLength(1);
    expect(calls.every((c) => c.cmd.includes("--remote"))).toBe(true);
  });

  test("a migrations folder that does not exist is reported with a fix", async () => {
    const r = await run(["db", "migrate", "--db", "app.sqlite", "--dir", "nowhere"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_DB_MIGRATIONS_DIR");
  });
});

const SCHEMA = `import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("member"),
  name: text("name"),
});

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
}, (t) => [index("posts_user").on(t.userId)]);

export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey(),
  body: text("body").notNull(),
});

export const notATable = 42;
`;

describe("miu db migrate --generate", () => {
  function project() {
    const dir = tempDir();
    linkWorkspace(dir, ["drizzle-orm"]);
    writeFileSync(join(dir, "schema.ts"), SCHEMA);
    migrationsDir(dir, { "0001_init.sql": INIT, "0002_tags.sql": "CREATE TABLE tags (name TEXT PRIMARY KEY);" });
    return dir;
  }

  test("diffs the schema against the replayed migrations and writes the next NNNN_<name>.sql", async () => {
    const dir = project();
    const r = await run(["db", "migrate", "--generate", "add comments", "--schema", "schema.ts"], dir);
    expect(r.code).toBe(0);
    const file = join(dir, "migrations", "0003_add_comments.sql");
    expect(existsSync(file)).toBe(true);
    const sql = readFileSync(file, "utf8");
    expect(sql).toContain('CREATE TABLE "comments"');
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "name" TEXT;');
    // Destructive changes are never generated, only reported for a human.
    expect(sql).not.toMatch(/^DROP TABLE/m);
    expect(sql).toContain('-- DROP TABLE "tags"');
    expect(r.out).toContain("Wrote migrations/0003_add_comments.sql");
    expect(r.out).toContain("warn");
    expect(r.out).toContain("Table tags is in the database but not in the schema");
  });

  test("the generated migration applies cleanly with miu db migrate", async () => {
    const dir = project();
    expect((await run(["db", "migrate", "--generate", "comments", "--schema", "schema.ts"], dir)).code).toBe(0);
    const r = await run(["db", "migrate", "--db", "app.sqlite"], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("applied 0003_comments");
    // Now the schema matches the database (apart from the extra table), so nothing new is generated.
    const again = await run(["db", "migrate", "--generate", "again", "--schema", "schema.ts", "--db", "app.sqlite"], dir);
    expect(again.code).toBe(0);
    expect(again.out).toContain("up to date");
    expect(readdirSync(join(dir, "migrations"))).toHaveLength(3);
  });

  test("--generate needs --schema", async () => {
    const r = await run(["db", "migrate", "--generate", "x"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_DB_USAGE");
    expect(r.err).toContain("--schema");
  });

  test("a schema without Drizzle tables is a MIU_E_CLI_SCHEMA_EMPTY error", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "schema.ts"), "export const x = 1;\n");
    const r = await run(["db", "migrate", "--generate", "x", "--schema", "schema.ts"], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_SCHEMA_EMPTY");
  });
});

describe("wrangler D1 adapter", () => {
  test("inlines ? and ?N parameters as SQL literals, leaving quoted text alone", async () => {
    const { inlineParams } = await import("../src/index.ts");
    expect(inlineParams("SELECT ?, '?', \"a?\", ?2, ?", [1, "o'k", null])).toBe("SELECT 1, '?', \"a?\", 'o''k', 'o''k'");
    expect(inlineParams("INSERT INTO t VALUES (?, ?, ?)", [true, new Uint8Array([1, 255]), 2n])).toBe("INSERT INTO t VALUES (1, X'01ff', 2)");
  });
});
