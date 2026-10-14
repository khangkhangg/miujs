import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { introspect, introspectMongo, mapColumnType, toCrudSource, toSchemaSource, type QueryFn, type Table } from "../../src/migrate/introspect.ts";

const SQLITE_DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email VARCHAR(255) NOT NULL,
  name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT 0,
  balance DECIMAL(10,2) NOT NULL DEFAULT 0,
  born DATE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  meta JSON
);
CREATE TABLE "order items" (order_id INTEGER NOT NULL, sku TEXT NOT NULL, qty INT NOT NULL DEFAULT 1, PRIMARY KEY (order_id, sku));
CREATE VIEW admins AS SELECT * FROM users WHERE is_admin = 1;
`;

function sqliteQuery(db: Database): QueryFn {
  return async (sql, params = []) => db.query(sql).all(...(params as any[])) as Record<string, unknown>[];
}

describe("introspect sqlite", () => {
  test("reads tables and columns from a real database", async () => {
    const db = new Database(":memory:");
    db.exec(SQLITE_DDL);
    const { tables } = await introspect({ dialect: "sqlite", query: sqliteQuery(db) });
    expect(tables.map((t) => t.name)).toEqual(["order items", "users"]);
    const users = tables.find((t) => t.name === "users")!;
    const col = (n: string) => users.columns.find((c) => c.name === n)!;
    expect(col("id")).toMatchObject({ type: "INTEGER", nullable: false, primaryKey: true, autoIncrement: true });
    expect(col("email")).toMatchObject({ type: "VARCHAR(255)", nullable: false, maxLength: 255, primaryKey: false });
    expect(col("name")).toMatchObject({ nullable: true, default: null });
    expect(col("is_admin")).toMatchObject({ default: "0" });
    expect(col("created_at").default).toBe("CURRENT_TIMESTAMP");
    const items = tables.find((t) => t.name === "order items")!;
    expect(items.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(["order_id", "sku"]);
    expect(items.columns[0]!.autoIncrement).toBe(false);
  });
});

describe("introspect mysql", () => {
  test("maps information_schema rows", async () => {
    const calls: string[] = [];
    const query: QueryFn = async (sql) => {
      calls.push(sql);
      return [
        { table_name: "posts", column_name: "id", column_type: "bigint unsigned", data_type: "bigint", is_nullable: "NO", column_default: null, column_key: "PRI", extra: "auto_increment", character_maximum_length: null },
        { table_name: "posts", column_name: "title", column_type: "varchar(191)", data_type: "varchar", is_nullable: "NO", column_default: null, column_key: "", extra: "", character_maximum_length: 191 },
        { table_name: "posts", column_name: "status", column_type: "enum('draft','published','it''s')", data_type: "enum", is_nullable: "NO", column_default: "draft", column_key: "", extra: "", character_maximum_length: 9 },
        { table_name: "posts", column_name: "published", column_type: "tinyint(1)", data_type: "tinyint", is_nullable: "NO", column_default: "0", column_key: "", extra: "", character_maximum_length: null },
        { table_name: "posts", column_name: "body", column_type: "longtext", data_type: "longtext", is_nullable: "YES", column_default: null, column_key: "", extra: "", character_maximum_length: 4294967295 },
        { table_name: "posts", column_name: "updated_at", column_type: "timestamp", data_type: "timestamp", is_nullable: "YES", column_default: "CURRENT_TIMESTAMP", column_key: "", extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP", character_maximum_length: null },
        { table_name: "tags", column_name: "name", column_type: "varchar(50)", data_type: "varchar", is_nullable: "NO", column_default: null, column_key: "PRI", extra: "", character_maximum_length: 50 },
      ];
    };
    const { tables } = await introspect({ dialect: "mysql", query });
    expect(calls[0]).toContain("DATABASE()");
    expect(tables.map((t) => t.name)).toEqual(["posts", "tags"]);
    const posts = tables[0]!;
    expect(posts.columns[0]).toEqual({ name: "id", type: "bigint unsigned", nullable: false, default: null, primaryKey: true, autoIncrement: true, maxLength: null });
    expect(posts.columns[1]!.maxLength).toBe(191);
    expect(posts.columns[2]).toMatchObject({ type: "enum('draft','published','it''s')", default: "draft", enumValues: ["draft", "published", "it's"] });
    expect(posts.columns[5]!.autoIncrement).toBe(false);
  });
});

describe("introspect postgres", () => {
  test("maps information_schema rows, primary keys and enums", async () => {
    const query: QueryFn = async (sql, params) => {
      expect(params?.[0] ?? "public").toBe("public");
      if (sql.includes("PRIMARY KEY")) return [{ table_name: "accounts", column_name: "id" }];
      if (sql.includes("pg_enum")) return [{ type_name: "mood", label: "happy" }, { type_name: "mood", label: "sad" }];
      return [
        { table_name: "accounts", column_name: "id", data_type: "integer", udt_name: "int4", is_nullable: "NO", column_default: "nextval('accounts_id_seq'::regclass)", character_maximum_length: null, is_identity: "NO" },
        { table_name: "accounts", column_name: "handle", data_type: "character varying", udt_name: "varchar", is_nullable: "NO", column_default: null, character_maximum_length: 40, is_identity: "NO" },
        { table_name: "accounts", column_name: "mood", data_type: "USER-DEFINED", udt_name: "mood", is_nullable: "YES", column_default: null, character_maximum_length: null, is_identity: "NO" },
        { table_name: "accounts", column_name: "settings", data_type: "jsonb", udt_name: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb", character_maximum_length: null, is_identity: "NO" },
        { table_name: "accounts", column_name: "seen_at", data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "YES", column_default: null, character_maximum_length: null, is_identity: "NO" },
        { table_name: "events", column_name: "eid", data_type: "bigint", udt_name: "int8", is_nullable: "NO", column_default: null, character_maximum_length: null, is_identity: "YES" },
      ];
    };
    const { tables } = await introspect({ dialect: "postgres", query });
    const acc = tables[0]!;
    expect(acc.columns[0]).toMatchObject({ name: "id", primaryKey: true, autoIncrement: true });
    expect(acc.columns[1]).toMatchObject({ type: "character varying", maxLength: 40 });
    expect(acc.columns[2]).toMatchObject({ type: "mood", enumValues: ["happy", "sad"] });
    expect(tables[1]!.columns[0]).toMatchObject({ autoIncrement: true, primaryKey: false });
  });
});

describe("introspectMongo", () => {
  test("infers fields from sampled documents", async () => {
    const docs: Record<string, Record<string, unknown>[]> = {
      users: [
        { _id: { _bsontype: "ObjectId", toHexString: () => "a" }, email: "a@x", age: 30, tags: ["x"], createdAt: new Date() },
        { _id: { _bsontype: "ObjectId", toHexString: () => "b" }, email: "b@x", age: 31.5, nickname: null, createdAt: new Date() },
        { _id: { _bsontype: "ObjectId", toHexString: () => "c" }, email: "c@x", age: "unknown", profile: { a: 1 }, createdAt: new Date() },
      ],
    };
    const sampled: number[] = [];
    const { tables } = await introspectMongo({ collections: ["users"], sample: async (c, n) => (sampled.push(n), docs[c]!) });
    expect(sampled).toEqual([100]);
    const cols = Object.fromEntries(tables[0]!.columns.map((c) => [c.name, c]));
    expect(cols._id).toMatchObject({ type: "objectid", primaryKey: true, optional: false });
    expect(cols.email).toMatchObject({ type: "string", nullable: false, optional: false });
    expect(cols.age!.type).toBe("mixed");
    expect(cols.tags).toMatchObject({ type: "array", optional: true });
    expect(cols.nickname).toMatchObject({ nullable: true, optional: true });
    expect(cols.createdAt!.type).toBe("datetime");
    expect(cols.profile!.type).toBe("object");
  });
});

describe("mapColumnType", () => {
  const col = (type: string, extra: Partial<Table["columns"][number]> = {}) => ({ name: "x", type, nullable: false, default: null, primaryKey: false, autoIncrement: false, maxLength: null, ...extra });
  test("SQL types to t.* expressions", () => {
    expect(mapColumnType(col("INTEGER"))).toBe("t.integer()");
    expect(mapColumnType(col("bigint unsigned"))).toBe("t.integer()");
    expect(mapColumnType(col("DECIMAL(10,2)"))).toBe("t.number()");
    expect(mapColumnType(col("double precision"))).toBe("t.number()");
    expect(mapColumnType(col("VARCHAR(255)", { maxLength: 255 }))).toBe("t.string({ max: 255 })");
    expect(mapColumnType(col("TEXT"))).toBe("t.string()");
    expect(mapColumnType(col("tinyint(1)"))).toBe("t.boolean()");
    expect(mapColumnType(col("BOOLEAN"))).toBe("t.boolean()");
    expect(mapColumnType(col("datetime"))).toBe('t.string({ format: "date-time" })');
    expect(mapColumnType(col("timestamp with time zone"))).toBe('t.string({ format: "date-time" })');
    expect(mapColumnType(col("date"))).toBe('t.string({ format: "date" })');
    expect(mapColumnType(col("jsonb"))).toBe("t.any()");
    expect(mapColumnType(col("uuid"))).toBe('t.string({ format: "uuid" })');
    expect(mapColumnType(col("enum('a','b')", { enumValues: ["a", "b"] }))).toBe('t.enum(["a", "b"])');
  });
});

describe("code generation", () => {
  test("toSchemaSource emits row, create and update schemas", async () => {
    const db = new Database(":memory:");
    db.exec(SQLITE_DDL);
    const { tables } = await introspect({ dialect: "sqlite", query: sqliteQuery(db) });
    const src = toSchemaSource(tables.find((t) => t.name === "users")!);
    expect(src).toContain("export const UsersSchema = t.object({");
    expect(src).toContain("  email: t.string({ max: 255 }),");
    expect(src).toContain("  name: t.nullable(t.string()),");
    expect(src).toContain("export const UsersCreateSchema = t.object({");
    expect(src).toMatch(/UsersCreateSchema = t\.object\(\{\n  id: t\.optional\(t\.integer\(\)\),/);
    expect(src).toContain("  is_admin: t.optional(t.boolean()),");
    expect(src).toContain("  name: t.optional(t.nullable(t.string())),");
    const items = toSchemaSource(tables.find((t) => t.name === "order items")!);
    expect(items).toContain("export const OrderItemsSchema");
  });

  test("generated CRUD module typechecks and works against bun:sqlite", async () => {
    const db = new Database(":memory:");
    db.exec(SQLITE_DDL);
    const { tables } = await introspect({ dialect: "sqlite", query: sqliteQuery(db) });
    const dir = join(import.meta.dir, "__generated__");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "miu.ts"),
      'export { Miu } from "../../../src/core/app.ts";\nexport { HttpError } from "../../../src/core/errors.ts";\nexport { t } from "../../../src/core/schema.ts";\nexport type { Infer } from "../../../src/core/schema.ts";\n',
    );
    const users = tables.find((t) => t.name === "users")!;
    const items = tables.find((t) => t.name === "order items")!;
    writeFileSync(join(dir, "users.ts"), toCrudSource(users, { routePrefix: "/api/users", importFrom: "./miu.ts" }));
    writeFileSync(join(dir, "items.ts"), toCrudSource(items, { importFrom: "./miu.ts" }));

    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "../../../tsconfig.json", include: [], files: ["users.ts", "items.ts"] }));
    const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", join(dir, "tsconfig.json")], { cwd: dir });
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
    expect(tsc.exitCode).toBe(0);

    const mod = await import(join(dir, "users.ts"));
    const adapter = {
      all: (sql: string, p: unknown[] = []) => db.query(sql).all(...(p as any[])) as Record<string, unknown>[],
      get: (sql: string, p: unknown[] = []) => (db.query(sql).get(...(p as any[])) ?? undefined) as Record<string, unknown> | undefined,
      run: (sql: string, p: unknown[] = []) => {
        const r = db.query(sql).run(...(p as any[]));
        return { changes: r.changes, lastInsertId: r.lastInsertRowid };
      },
    };
    const app = mod.createUsersRoutes(adapter);
    const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await app.request("/api/users", json({ email: "a@x.io", name: "Ann", is_admin: true }));
    expect(created.status).toBe(201);
    const row = await created.json();
    expect(row).toMatchObject({ id: 1, email: "a@x.io", name: "Ann", is_admin: 1, balance: 0 });

    expect((await app.request("/api/users", json({ name: "no email" }))).status).toBe(422);
    expect((await app.request("/api/users", json({ email: "x".repeat(256) }))).status).toBe(422);

    await app.request("/api/users", json({ email: "b@x.io" }));
    expect(await (await app.request("/api/users")).json()).toHaveLength(2);
    expect(await (await app.request("/api/users?limit=1&offset=1")).json()).toMatchObject([{ email: "b@x.io" }]);
    expect(await (await app.request("/api/users/1")).json()).toMatchObject({ email: "a@x.io" });
    expect((await app.request("/api/users/99")).status).toBe(404);

    const patched = await app.request("/api/users/1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Anne", id: 50 }) });
    expect(await patched.json()).toMatchObject({ id: 1, name: "Anne" });
    expect((await app.request("/api/users/99", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);

    expect((await app.request("/api/users/1", { method: "DELETE" })).status).toBe(204);
    expect((await app.request("/api/users/1")).status).toBe(404);
    expect((await app.request("/api/users/1", { method: "DELETE" })).status).toBe(404);

    // Composite primary key: list + create only.
    const itemsApp = (await import(join(dir, "items.ts"))).createOrderItemsRoutes(adapter);
    const ci = await itemsApp.request("/order-items", json({ order_id: 1, sku: "A" }));
    expect(ci.status).toBe(201);
    expect(await (await itemsApp.request("/order-items")).json()).toEqual([{ order_id: 1, sku: "A", qty: 1 }]);
    expect(itemsApp.routes.map((r: { method: string; path: string }) => `${r.method} ${r.path}`)).toEqual(["GET /order-items", "POST /order-items"]);
  }, 60_000);

  test("postgres and mysql CRUD use dialect placeholders and quoting", () => {
    const table: Table = {
      name: "posts",
      columns: [
        { name: "id", type: "integer", nullable: false, default: null, primaryKey: true, autoIncrement: true, maxLength: null },
        { name: "title", type: "varchar", nullable: false, default: null, primaryKey: false, autoIncrement: false, maxLength: 100 },
      ],
    };
    const pg = toCrudSource(table, { dialect: "postgres" });
    expect(pg).toContain('SELECT * FROM "posts" WHERE "id" = $1');
    expect(pg).toContain("RETURNING *");
    const my = toCrudSource(table, { dialect: "mysql" });
    expect(my).toContain("SELECT * FROM `posts` WHERE `id` = ?");
    expect(my).toContain("lastInsertId");
    expect(my).not.toContain("RETURNING");
  });
});
