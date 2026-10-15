import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { miu, route } from "miujs";
import { db, d1, sqlite, type Database } from "../src/index.ts";
import { drizzle, drizzleFor } from "../src/drizzle.ts";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  admin: integer("admin", { mode: "boolean" }).notNull().default(false),
});
const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
});
const schema = { users, posts };

// Types `ctx.orm` for this app, as the docs tell users to do.
declare module "../src/drizzle.ts" {
  interface DrizzleRegister {
    schema: typeof schema;
  }
}

const DDL = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, admin INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL);
`;

async function fresh(): Promise<Database> {
  const database = sqlite();
  await database.exec(DDL);
  return database;
}

describe("raw() on sqlite statements (D1 parity)", () => {
  test("returns rows as arrays in column order, keeping duplicate column names", async () => {
    const database = await fresh();
    await database.prepare("INSERT INTO users (email) VALUES (?)").bind("a@x").run();
    expect(await database.prepare("SELECT id, email, id FROM users").raw()).toEqual([[1, "a@x", 1]]);
    expect(await database.prepare("SELECT id, email FROM users").raw({ columnNames: true })).toEqual([["id", "email"], [1, "a@x"]]);
  });
});

describe("drizzleFor(database)", () => {
  test("insert, select, update and delete through Drizzle on sqlite()", async () => {
    const orm = drizzleFor(await fresh(), { schema });
    const [alice] = await orm.insert(users).values({ email: "alice@x" }).returning();
    expect(alice).toEqual({ id: 1, email: "alice@x", admin: false });
    await orm.insert(users).values({ email: "bob@x", admin: true });
    expect(await orm.select().from(users).where(eq(users.admin, true))).toEqual([{ id: 2, email: "bob@x", admin: true }]);
    await orm.update(users).set({ admin: true }).where(eq(users.id, 1));
    const count = await orm.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.admin, true)).get();
    expect(count).toEqual({ n: 2 });
    await orm.delete(users).where(eq(users.id, 2));
    expect((await orm.select({ email: users.email }).from(users)).map((u) => u.email)).toEqual(["alice@x"]);
  });

  test("joins map columns correctly", async () => {
    const orm = drizzleFor(await fresh(), { schema });
    await orm.insert(users).values({ email: "a@x" });
    await orm.insert(posts).values([{ authorId: 1, title: "Hello" }, { authorId: 1, title: "Again" }]);
    const rows = await orm
      .select({ id: posts.id, title: posts.title, author: users.email, authorId: users.id })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .orderBy(posts.id);
    expect(rows).toEqual([
      { id: 1, title: "Hello", author: "a@x", authorId: 1 },
      { id: 2, title: "Again", author: "a@x", authorId: 1 },
    ]);
  });

  test("relational query API sees the schema", async () => {
    const orm = drizzleFor(await fresh(), { schema });
    await orm.insert(users).values({ email: "q@x" });
    expect(await orm.query.users.findFirst({ where: eq(users.email, "q@x") })).toEqual({ id: 1, email: "q@x", admin: false });
  });

  test("batch() runs atomically", async () => {
    const database = await fresh();
    const orm = drizzleFor(database, { schema });
    const [, rows] = await orm.batch([orm.insert(users).values({ email: "b1@x" }), orm.select().from(users)]);
    expect(rows).toEqual([{ id: 1, email: "b1@x", admin: false }]);
    await expect(orm.batch([orm.insert(users).values({ email: "b2@x" }), orm.insert(users).values({ email: "b1@x" })])).rejects.toThrow();
    expect(await orm.select().from(users)).toHaveLength(1);
  });

  test("transaction() commits and rolls back", async () => {
    const orm = drizzleFor(await fresh(), { schema });
    await orm.transaction(async (tx) => {
      await tx.insert(users).values({ email: "t1@x" });
    });
    await expect(
      orm.transaction(async (tx) => {
        await tx.insert(users).values({ email: "t2@x" });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect((await orm.select().from(users)).map((u) => u.email)).toEqual(["t1@x"]);
  });

  test("returns the same instance for the same database when no options are passed", async () => {
    const database = await fresh();
    expect(drizzleFor(database)).toBe(drizzleFor(database));
    expect(drizzleFor(database)).not.toBe(drizzleFor(await fresh()));
  });
});

describe("drizzle(ctx) and db({ drizzle })", () => {
  test("db({ drizzle: { schema } }) decorates ctx.orm", async () => {
    const database = await fresh();
    const app = miu({
      plugins: [db({ database, drizzle: { schema } })],
      routes: [
        route.post("/users", {
          handler: async (ctx) => (await ctx.orm.insert(users).values({ email: "p@x" }).returning())[0],
        }),
        route.get("/users", { handler: async (ctx) => ({ users: await ctx.orm.query.users.findMany() }) }),
      ],
      logLevel: "silent",
    });
    expect(await (await app.fetch(new Request("http://localhost/users", { method: "POST" }))).json()).toEqual({ id: 1, email: "p@x", admin: false });
    expect(await (await app.fetch(new Request("http://localhost/users"))).json()).toEqual({ users: [{ id: 1, email: "p@x", admin: false }] });
  });

  test("drizzle(ctx) works with or without the plugin option", async () => {
    const database = await fresh();
    await database.prepare("INSERT INTO users (email) VALUES (?)").bind("c@x").run();
    const app = miu({
      plugins: [db({ database })],
      routes: [route.get("/n", { handler: async (ctx) => ({ rows: await drizzle(ctx).select({ email: users.email }).from(users) }) })],
      logLevel: "silent",
    });
    expect(await (await app.fetch(new Request("http://localhost/n"))).json()).toEqual({ rows: [{ email: "c@x" }] });
  });

  test("ctx.orm follows a d1(name) binding per request", async () => {
    const a = await fresh();
    const b = await fresh();
    await a.prepare("INSERT INTO users (email) VALUES (?)").bind("in-a").run();
    await b.prepare("INSERT INTO users (email) VALUES (?)").bind("in-b").run();
    const app = miu({
      plugins: [db({ database: d1("DB"), drizzle: { schema } })],
      routes: [route.get("/n", { handler: async (ctx) => ({ email: (await ctx.orm.select().from(users).get())?.email }) })],
      logLevel: "silent",
    });
    const call = async (DB: Database) => (await app.dispatch(new Request("http://localhost/n"), { DB }, { runtime: "bun" })).json();
    expect(await call(a)).toEqual({ email: "in-a" });
    expect(await call(b)).toEqual({ email: "in-b" });
  });

  test("drizzle(ctx) without ctx.db explains the fix", () => {
    let err: any;
    try {
      drizzle({} as any);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_DB_MISSING");
    expect(err.fix).toContain("db(");
  });

  test("on Bun, db({ drizzle }) loads Drizzle lazily without an explicit import", async () => {
    // A fresh process, so the factory is not already registered by this test file's import.
    const script = `
      import { miu, route } from "miujs";
      import { db } from "./src/index.ts";
      const app = miu({ plugins: [db({ drizzle: {} })], logLevel: "silent",
        routes: [route.get("/", { handler: async (ctx) => ({ has: typeof ctx.orm.select === "function" }) })] });
      console.log(await (await app.fetch(new Request("http://localhost/"))).text());
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(errText).toBe("");
    expect(out.trim()).toBe('{"has":true}');
  });

  test("inspect() mentions drizzle tables", () => {
    expect(db({ database: sqlite(), drizzle: { schema } }).inspect()).toEqual({ adapter: "sqlite", path: ":memory:", drizzle: { tables: ["users", "posts"] } });
  });
});
