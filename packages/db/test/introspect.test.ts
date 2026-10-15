import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { generateDrizzleSchema, introspect, migrate, sqlite, type Database, type SchemaDescription } from "../src/index.ts";
import { drizzleFor } from "../src/drizzle.ts";

const DDL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    score REAL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'))
  );
  CREATE INDEX users_name_idx ON users (name);
  CREATE TABLE memberships (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org TEXT NOT NULL,
    PRIMARY KEY (user_id, org)
  );
  CREATE UNIQUE INDEX memberships_org ON memberships (org, user_id) WHERE org <> '';
  CREATE VIEW admins AS SELECT * FROM users WHERE role = 'admin';
`;

async function fixture(): Promise<Database> {
  const database = sqlite();
  await migrate(database, [{ id: "0001_init", sql: DDL }]);
  return database;
}

describe("introspect()", () => {
  test("describes tables, columns, primary keys, indexes and foreign keys", async () => {
    const desc = await introspect(await fixture());
    expect(desc.tables.map((t) => t.name)).toEqual(["users", "memberships"]);
    const [users, memberships] = desc.tables;
    expect(users.columns).toEqual([
      { name: "id", type: "INTEGER", notNull: false, default: null, primaryKey: true, autoIncrement: true },
      { name: "email", type: "TEXT", notNull: true, default: null, primaryKey: false },
      { name: "name", type: "TEXT", notNull: false, default: null, primaryKey: false },
      { name: "created_at", type: "TEXT", notNull: true, default: "CURRENT_TIMESTAMP", primaryKey: false },
      { name: "score", type: "REAL", notNull: false, default: "0", primaryKey: false },
      { name: "role", type: "TEXT", notNull: true, default: "'member'", primaryKey: false },
    ]);
    expect(users.primaryKey).toEqual(["id"]);
    expect(users.indexes).toEqual([
      { name: "users_name_idx", columns: ["name"], unique: false, origin: "c" },
      { name: "sqlite_autoindex_users_1", columns: ["email"], unique: true, origin: "u" },
    ]);
    expect(users.foreignKeys).toEqual([]);
    expect(users.sql).toContain("CHECK (role IN");

    expect(memberships.primaryKey).toEqual(["user_id", "org"]);
    expect(memberships.columns.map((c) => [c.name, c.primaryKey])).toEqual([
      ["user_id", true],
      ["org", true],
    ]);
    expect(memberships.indexes).toEqual([
      { name: "memberships_org", columns: ["org", "user_id"], unique: true, origin: "c", where: "org <> ''" },
      { name: "sqlite_autoindex_memberships_1", columns: ["user_id", "org"], unique: true, origin: "pk" },
    ]);
    expect(memberships.foreignKeys).toEqual([{ columns: ["user_id"], table: "users", references: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" }]);
  });

  test("skips internal tables (sqlite_*, _miu_migrations, Cloudflare's _cf_* and d1_migrations)", async () => {
    const database = await fixture();
    await database.exec("CREATE TABLE _cf_KV (k TEXT); CREATE TABLE d1_migrations (id INTEGER)");
    const names = (await introspect(database)).tables.map((t) => t.name);
    expect(names).toEqual(["users", "memberships"]);
  });

  test("quotes odd table and column names", async () => {
    const database = sqlite();
    await database.exec(`CREATE TABLE "my table" ("first name" TEXT, "it's" INTEGER); CREATE INDEX "my idx" ON "my table" ("first name")`);
    const [table] = (await introspect(database)).tables;
    expect(table.columns.map((c) => c.name)).toEqual(["first name", "it's"]);
    expect(table.indexes[0]).toEqual({ name: "my idx", columns: ["first name"], unique: false, origin: "c" });
  });

  test("foreign keys come back in declaration order", async () => {
    const database = sqlite();
    await database.exec(`
      CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY);
      CREATE TABLE c (a_id INTEGER REFERENCES a(id), b_id INTEGER REFERENCES b(id));
    `);
    const c = (await introspect(database)).tables.find((t) => t.name === "c")!;
    expect(c.foreignKeys.map((f) => f.table)).toEqual(["a", "b"]);
  });

  test("the description is plain JSON", async () => {
    const desc = await introspect(await fixture());
    expect(JSON.parse(JSON.stringify(desc))).toEqual(desc);
  });
});

const GEN_DIR = `${import.meta.dir}/.gen`;
let genCount = 0;
async function load(source: string): Promise<Record<string, SQLiteTable>> {
  mkdirSync(GEN_DIR, { recursive: true });
  // A fresh directory per module: Bun caches directory listings during resolution.
  const dir = `${GEN_DIR}/${Date.now()}_${genCount++}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/schema.ts`;
  writeFileSync(file, source);
  return import(file);
}
afterAll(() => rmSync(GEN_DIR, { recursive: true, force: true }));

describe("generateDrizzleSchema()", () => {
  test("emits importable TypeScript whose tables match the database", async () => {
    const database = await fixture();
    const source = generateDrizzleSchema(await introspect(database));
    expect(source).toContain('from "drizzle-orm/sqlite-core"');
    const mod = await load(source);
    expect(Object.keys(mod).sort()).toEqual(["memberships", "users"]);

    const users = getTableConfig(mod.users);
    expect(users.name).toBe("users");
    expect(users.columns.map((c) => [c.name, c.getSQLType(), c.notNull, c.primary, c.hasDefault])).toEqual([
      ["id", "integer", true, true, true], // autoincrement counts as a default
      ["email", "text", true, false, false],
      ["name", "text", false, false, false],
      ["created_at", "text", true, false, true],
      ["score", "real", false, false, true],
      ["role", "text", true, false, true],
    ]);
    expect(users.columns.find((c) => c.name === "email")!.isUnique).toBe(true);
    expect(users.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([["users_name_idx", false]]);

    const memberships = getTableConfig(mod.memberships);
    expect(memberships.primaryKeys.map((pk) => pk.columns.map((c) => c.name))).toEqual([["user_id", "org"]]);
    expect(memberships.indexes.map((i) => [i.config.name, i.config.unique, !!i.config.where])).toEqual([["memberships_org", true, true]]);
    const fk = memberships.foreignKeys[0].reference();
    expect([fk.columns.map((c) => c.name), getTableConfig(fk.foreignTable).name, fk.foreignColumns.map((c) => c.name)]).toEqual([["user_id"], "users", ["id"]]);
    expect(memberships.foreignKeys[0].onDelete).toBe("cascade");
  });

  test("the generated schema queries the real database", async () => {
    const database = await fixture();
    const mod = await load(generateDrizzleSchema(await introspect(database)));
    const orm = drizzleFor(database, { schema: mod });
    const [u] = await orm.insert(mod.users).values({ email: "a@x" } as any).returning();
    expect(u).toMatchObject({ id: 1, email: "a@x", name: null, score: 0, role: "member" });
    await orm.insert(mod.memberships).values({ userId: 1, org: "acme" } as any);
    const rows = await orm.select().from(mod.memberships).where(eq((mod.memberships as any).org, "acme"));
    expect(rows).toEqual([{ userId: 1, org: "acme" }]);
  });

  test("names: camelCase exports and keys, safe identifiers, quoted SQL names", async () => {
    const desc: SchemaDescription = {
      tables: [
        {
          name: "order-items",
          columns: [
            { name: "Order ID", type: "INTEGER", notNull: true, default: null, primaryKey: true },
            { name: "class", type: "TEXT", notNull: false, default: null, primaryKey: false },
            { name: "2fa", type: "BOOLEAN", notNull: false, default: null, primaryKey: false },
            { name: "blobby", type: "", notNull: false, default: null, primaryKey: false },
            { name: "price", type: "DECIMAL(10,2)", notNull: false, default: null, primaryKey: false },
            { name: "ratio", type: "DOUBLE PRECISION", notNull: false, default: "-1.5", primaryKey: false },
            { name: "note", type: "VARCHAR(20)", notNull: false, default: "'it''s'", primaryKey: false },
          ],
          primaryKey: ["Order ID"],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const source = generateDrizzleSchema(desc);
    expect(source).toContain('export const orderItems = sqliteTable("order-items", {');
    expect(source).toContain('orderId: integer("Order ID").primaryKey()');
    expect(source).toContain('class: text("class")');
    expect(source).toContain('_2fa: integer("2fa", { mode: "boolean" })');
    expect(source).toContain('blobby: blob("blobby")');
    expect(source).toContain('price: numeric("price")');
    expect(source).toContain('ratio: real("ratio").default(-1.5)');
    expect(source).toContain(`note: text("note").default("it's")`);
    const mod = await load(source);
    expect(getTableConfig(mod.orderItems).columns.map((c) => c.getSQLType())).toEqual(["integer", "text", "integer", "blob", "numeric", "real", "text"]);
  });

  test("self references and composite foreign keys", async () => {
    const database = sqlite();
    await database.exec(`
      CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id));
      CREATE TABLE a (x INTEGER, y INTEGER, PRIMARY KEY (x, y));
      CREATE TABLE b (id INTEGER PRIMARY KEY, ax INTEGER, ay INTEGER, FOREIGN KEY (ax, ay) REFERENCES a (x, y) ON UPDATE CASCADE);
    `);
    const mod = await load(generateDrizzleSchema(await introspect(database)));
    const nodeFk = getTableConfig(mod.nodes).foreignKeys[0].reference();
    expect(getTableConfig(nodeFk.foreignTable).name).toBe("nodes");
    const bFk = getTableConfig(mod.b).foreignKeys[0];
    expect(bFk.reference().columns.map((c) => c.name)).toEqual(["ax", "ay"]);
    expect(bFk.reference().foreignColumns.map((c) => c.name)).toEqual(["x", "y"]);
    expect(bFk.onUpdate).toBe("cascade");
  });

  test("tables named like keywords or imported helpers get a Table suffix", async () => {
    const database = sqlite();
    await database.exec(`CREATE TABLE "index" (id INTEGER PRIMARY KEY); CREATE TABLE text (id INTEGER PRIMARY KEY); CREATE TABLE "class" (id INTEGER PRIMARY KEY)`);
    const mod = await load(generateDrizzleSchema(await introspect(database)));
    expect(Object.keys(mod).sort()).toEqual(["classTable", "indexTable", "textTable"]);
    expect(getTableConfig(mod.textTable).name).toBe("text");
  });

  test("an empty description still produces a valid module", async () => {
    const mod = await load(generateDrizzleSchema({ tables: [] }));
    expect(Object.keys(mod)).toEqual([]);
  });
});
