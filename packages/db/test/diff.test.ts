import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { t } from "miujs";
import { introspect, migrate, sqlite, type Database } from "../src/index.ts";
import { describeTable, diffSchema, tableFromSchema } from "../src/drizzle.ts";

async function dbWith(ddl: string): Promise<Database> {
  const database = sqlite();
  if (ddl) await database.exec(ddl);
  return database;
}

/** Applies the suggested statements and returns the diff against the result (should be empty). */
async function applyAndRediff(database: Database, tables: Parameters<typeof diffSchema>[1]) {
  const first = diffSchema(await introspect(database), tables);
  await migrate(database, [{ id: "auto", sql: first.sql }]);
  return { first, second: diffSchema(await introspect(database), tables) };
}

const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    name: text("name"),
    role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (u) => [index("users_name_idx").on(u.name)],
);
const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
});

describe("describeTable()", () => {
  test("turns a Drizzle table into the introspection shape", () => {
    expect(describeTable(users)).toEqual({
      name: "users",
      columns: [
        { name: "id", type: "INTEGER", notNull: false, default: null, primaryKey: true, autoIncrement: true },
        { name: "email", type: "TEXT", notNull: true, default: null, primaryKey: false },
        { name: "name", type: "TEXT", notNull: false, default: null, primaryKey: false },
        { name: "role", type: "TEXT", notNull: true, default: "'member'", primaryKey: false, enum: ["admin", "member"] },
        { name: "created_at", type: "TEXT", notNull: true, default: "(CURRENT_TIMESTAMP)", primaryKey: false },
        { name: "active", type: "INTEGER", notNull: true, default: "1", primaryKey: false },
      ],
      primaryKey: ["id"],
      indexes: [
        { name: "users_name_idx", columns: ["name"], unique: false, origin: "c" },
        { name: "users_email_unique", columns: ["email"], unique: true, origin: "u" },
      ],
      foreignKeys: [],
      checks: [],
    });
    expect(describeTable(posts).foreignKeys).toEqual([{ columns: ["author_id"], table: "users", references: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" }]);
  });

  test("composite primary keys, unique constraints and partial indexes", () => {
    const m = sqliteTable(
      "m",
      { a: integer("a").notNull(), b: text("b").notNull(), c: text("c") },
      (x) => [primaryKey({ columns: [x.a, x.b] }), unique("m_bc").on(x.b, x.c), uniqueIndex("m_c").on(x.c).where(sql`c IS NOT NULL`)],
    );
    const d = describeTable(m);
    expect(d.primaryKey).toEqual(["a", "b"]);
    expect(d.indexes).toEqual([
      { name: "m_c", columns: ["c"], unique: true, origin: "c", where: "c IS NOT NULL" },
      { name: "m_bc", columns: ["b", "c"], unique: true, origin: "u" },
    ]);
  });
});

describe("diffSchema()", () => {
  test("creates missing tables (with indexes and foreign keys) and the result matches", async () => {
    const database = await dbWith("");
    const { first, second } = await applyAndRediff(database, [users, posts]);
    expect(first.statements.map((s) => s.split(" (")[0].split("\n")[0])).toEqual([
      'CREATE TABLE "users"',
      'CREATE INDEX "users_name_idx" ON "users"',
      'CREATE TABLE "posts"',
    ]);
    expect(first.warnings).toEqual([]);
    expect(second).toEqual({ statements: [], warnings: [], sql: "" });
    // FK and CHECK made it into the database.
    await database.prepare("INSERT INTO users (email) VALUES ('a@x')").run();
    await expect(database.prepare("INSERT INTO posts (author_id, title) VALUES (99, 't')").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(database.prepare("INSERT INTO users (email, role) VALUES ('b@x', 'root')").run()).rejects.toThrow(/CHECK/);
  });

  test("adds new nullable / defaulted columns with ALTER TABLE ADD COLUMN", async () => {
    const database = await dbWith(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE);
      CREATE INDEX users_name_idx ON users (email)`);
    const { first, second } = await applyAndRediff(database, [users]);
    expect(first.statements).toEqual([
      `ALTER TABLE "users" ADD COLUMN "name" TEXT`,
      `ALTER TABLE "users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member' CHECK ("role" IN ('admin', 'member'))`,
      `ALTER TABLE "users" ADD COLUMN "active" INTEGER NOT NULL DEFAULT 1`,
    ]);
    // created_at has a non-constant default, which SQLite cannot add to an existing table.
    expect(first.warnings.map((w) => [w.kind, w.table, w.column])).toEqual([["unsupported", "users", "created_at"]]);
    expect(first.warnings[0].message).toContain("CURRENT_TIMESTAMP");
    expect(second.statements).toEqual([]);
  });

  test("adds a referencing column with an inline REFERENCES clause", async () => {
    const database = await dbWith(`CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`);
    const withNullableAuthor = sqliteTable("posts", {
      id: integer("id").primaryKey(),
      authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
      title: text("title").notNull(),
    });
    const { first } = await applyAndRediff(database, [withNullableAuthor]);
    expect(first.statements).toEqual([`ALTER TABLE "posts" ADD COLUMN "author_id" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL`]);
    const [, postsDesc] = (await introspect(database)).tables;
    expect(postsDesc.foreignKeys).toEqual([{ columns: ["author_id"], table: "users", references: ["id"], onUpdate: "NO ACTION", onDelete: "SET NULL" }]);
  });

  test("NOT NULL without a default, PRIMARY KEY and UNIQUE columns cannot be added: warnings, no SQL", async () => {
    const database = await dbWith(`CREATE TABLE posts (id INTEGER PRIMARY KEY)`);
    const target = sqliteTable("posts", {
      id: integer("id").primaryKey(),
      title: text("title").notNull(),
      slug: text("slug").unique(),
    });
    const diff = diffSchema(await introspect(database), [target]);
    expect(diff.statements).toEqual([]);
    expect(diff.warnings.map((w) => [w.kind, w.column])).toEqual([
      ["unsupported", "title"],
      ["unsupported", "slug"],
    ]);
    expect(diff.warnings[0].message).toContain("NOT NULL");
    expect(diff.warnings[1].message).toContain("UNIQUE");
  });

  test("adds missing indexes; matches unique constraints by columns, not names", async () => {
    const database = await dbWith(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, active INTEGER NOT NULL DEFAULT 1);
      CREATE UNIQUE INDEX some_other_name ON users (email);`);
    const diff = diffSchema(await introspect(database), [users]);
    expect(diff.statements).toEqual([`CREATE INDEX "users_name_idx" ON "users" ("name")`]);
    expect(diff.warnings).toEqual([]);
  });

  test("suggests a unique index when a unique constraint is missing", async () => {
    const database = await dbWith(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX users_name_idx ON users (name);`);
    const { first, second } = await applyAndRediff(database, [users]);
    expect(first.statements).toEqual([`CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email")`]);
    expect(second.statements).toEqual([]);
  });

  test("destructive changes are reported, never generated", async () => {
    const database = await dbWith(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name INTEGER, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, active INTEGER NOT NULL DEFAULT 1, legacy TEXT);
      CREATE INDEX users_name_idx ON users (name);
      CREATE INDEX users_legacy_idx ON users (legacy);
      CREATE TABLE old_stuff (x INTEGER);
    `);
    const diff = diffSchema(await introspect(database), [users]);
    expect(diff.statements).toEqual([]);
    expect(diff.sql).toBe("");
    expect(diff.warnings.map((w) => [w.kind, w.table, w.column ?? w.index ?? null])).toEqual([
      ["change-column", "users", "name"],
      ["drop-column", "users", "legacy"],
      ["drop-index", "users", "users_legacy_idx"],
      ["drop-table", "old_stuff", null],
    ]);
    expect(diff.warnings.find((w) => w.kind === "drop-table")!.sql).toBe(`DROP TABLE "old_stuff"`);
    expect(diff.warnings.find((w) => w.kind === "drop-column")!.sql).toBe(`ALTER TABLE "users" DROP COLUMN "legacy"`);
    expect(diff.warnings.find((w) => w.kind === "drop-index")!.sql).toBe(`DROP INDEX "users_legacy_idx"`);
    expect(diff.warnings.find((w) => w.kind === "change-column")!.message).toContain("INTEGER");
  });

  test("ignores the internal migrations table and tables listed in ignore", async () => {
    const database = await dbWith(`CREATE TABLE sessions (id TEXT PRIMARY KEY)`);
    await migrate(database, [{ id: "1", sql: "CREATE TABLE audit (x INTEGER)" }]);
    const diff = diffSchema(await introspect(database), [], { ignore: ["sessions", "audit"] });
    expect(diff.warnings).toEqual([]);
  });

  test("accepts tableFromSchema results and plain descriptions too", async () => {
    const notes = tableFromSchema("notes", t.object({ id: t.integer(), body: t.string(), done: t.default(t.boolean(), false) }), { indexes: ["done"] });
    const database = await dbWith("");
    const { first, second } = await applyAndRediff(database, [notes.table, { name: "kv", columns: [{ name: "k", type: "TEXT", notNull: true, default: null, primaryKey: true }], primaryKey: ["k"], indexes: [], foreignKeys: [] }]);
    expect(first.statements).toEqual([...notes.sql, `CREATE TABLE "kv" (\n  "k" TEXT PRIMARY KEY NOT NULL\n)`]);
    expect(second.statements).toEqual([]);
    expect(second.warnings).toEqual([]);
  });

  test("sql is the statements joined into one migration", async () => {
    const diff = diffSchema({ tables: [] }, [posts, users]);
    expect(diff.sql).toBe(diff.statements.map((s) => `${s};`).join("\n"));
  });
});
