import { describe, expect, test } from "bun:test";
import { miu, route, isMiuError } from "miujs";
import { db, d1, migrate, resolveDatabase, sqlite, type Database } from "../src/index.ts";

async function fresh(): Promise<Database> {
  const database = sqlite();
  await database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, done INTEGER)");
  return database;
}

describe("sqlite adapter (D1-compatible)", () => {
  test("run() reports changes and last_row_id", async () => {
    const database = await fresh();
    const r = await database.prepare("INSERT INTO notes (body, done) VALUES (?, ?)").bind("a", 0).run();
    expect(r.success).toBe(true);
    expect(r.meta.changes).toBe(1);
    expect(r.meta.last_row_id).toBe(1);
    const r2 = await database.prepare("INSERT INTO notes (body, done) VALUES (?1, ?2)").bind("b", 1).run();
    expect(r2.meta.last_row_id).toBe(2);
  });

  test("all() returns { results }", async () => {
    const database = await fresh();
    await database.prepare("INSERT INTO notes (body, done) VALUES (?, ?)").bind("a", 0).run();
    await database.prepare("INSERT INTO notes (body, done) VALUES (?, ?)").bind("b", 1).run();
    const { results } = await database.prepare("SELECT body FROM notes ORDER BY id").all<{ body: string }>();
    expect(results).toEqual([{ body: "a" }, { body: "b" }]);
  });

  test("first() returns a row, a column, or null", async () => {
    const database = await fresh();
    await database.prepare("INSERT INTO notes (body, done) VALUES (?, ?)").bind("a", 0).run();
    expect(await database.prepare("SELECT body FROM notes WHERE id = ?").bind(1).first()).toEqual({ body: "a" });
    expect(await database.prepare("SELECT body FROM notes WHERE id = ?").bind(1).first<string>("body")).toBe("a");
    expect(await database.prepare("SELECT body FROM notes WHERE id = ?").bind(99).first()).toBeNull();
  });

  test("bind() converts booleans to integers like D1 and returns a new statement", async () => {
    const database = await fresh();
    const insert = database.prepare("INSERT INTO notes (body, done) VALUES (?, ?)");
    await insert.bind("x", true).run();
    await insert.bind("y", false).run();
    const { results } = await database.prepare("SELECT done FROM notes ORDER BY id").all<{ done: number }>();
    expect(results.map((r) => r.done)).toEqual([1, 0]);
  });

  test("bind(undefined) is rejected with a fix", async () => {
    const database = await fresh();
    let err: unknown;
    try {
      await database.prepare("INSERT INTO notes (body) VALUES (?)").bind(undefined).run();
    } catch (e) {
      err = e;
    }
    expect(isMiuError(err)).toBe(true);
    expect((err as any).code).toBe("MIU_E_DB_BIND_UNDEFINED");
    expect((err as any).fix).toBeTruthy();
  });

  test("batch() runs statements in one transaction and rolls back on failure", async () => {
    const database = await fresh();
    const ins = database.prepare("INSERT INTO notes (id, body) VALUES (?, ?)");
    const res = await database.batch([ins.bind(1, "a"), ins.bind(2, "b"), database.prepare("SELECT count(*) AS n FROM notes")]);
    expect(res.length).toBe(3);
    expect(res[2].results).toEqual([{ n: 2 }]);
    await expect(database.batch([ins.bind(3, "c"), ins.bind(1, "dup")])).rejects.toThrow();
    expect(await database.prepare("SELECT count(*) AS n FROM notes").first("n")).toBe(2);
  });

  test("exec() runs several statements", async () => {
    const database = sqlite();
    const r = await database.exec("CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);");
    expect(r.count).toBe(2);
    await database.prepare("INSERT INTO b (y) VALUES (?)").bind(1).run();
  });

  test("sqlite() persists to a file path", async () => {
    const path = `${process.env.TEMP ?? "/tmp"}/miu-db-test-${Date.now()}.sqlite`;
    const a = sqlite(path);
    await a.exec("CREATE TABLE t (x INTEGER)");
    await a.prepare("INSERT INTO t (x) VALUES (?)").bind(42).run();
    const b = sqlite(path);
    expect(await b.prepare("SELECT x FROM t").first("x")).toBe(42);
  });
});

describe("d1 adapter", () => {
  test("d1(binding) passes the binding through", () => {
    const fake = sqlite();
    expect(resolveDatabase(d1(fake as any), {})).toBe(fake);
  });

  test("d1(name) resolves the binding from env per request", () => {
    const a = sqlite();
    const b = sqlite();
    const source = d1("DB");
    expect(resolveDatabase(source, { DB: a })).toBe(a);
    expect(resolveDatabase(source, { DB: b })).toBe(b);
  });

  test("d1(name) with a missing binding throws MIU_E_DB_BINDING_MISSING", () => {
    let err: any;
    try {
      resolveDatabase(d1("DB"), {});
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_DB_BINDING_MISSING");
    expect(err.fix).toContain("DB");
  });
});

describe("migrate()", () => {
  const migrations = [
    { id: "001_users", sql: "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);\nCREATE INDEX users_email ON users (email);" },
    { id: "002_posts", sql: "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)" },
  ];

  test("applies pending migrations once and records them", async () => {
    const database = sqlite();
    expect(await migrate(database, migrations)).toEqual(["001_users", "002_posts"]);
    expect(await migrate(database, migrations)).toEqual([]);
    const { results } = await database.prepare("SELECT id FROM _miu_migrations ORDER BY id").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["001_users", "002_posts"]);
    await database.prepare("INSERT INTO posts (id, title) VALUES (?, ?)").bind("p", "t").run();
  });

  test("a failing migration is not recorded and earlier ones stay applied", async () => {
    const database = sqlite();
    const bad = [...migrations, { id: "003_bad", sql: "CREATE TABLE posts (id TEXT)" }];
    await expect(migrate(database, bad)).rejects.toThrow();
    const { results } = await database.prepare("SELECT id FROM _miu_migrations ORDER BY id").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["001_users", "002_posts"]);
  });

  test("semicolons inside string literals do not split statements", async () => {
    const database = sqlite();
    await migrate(database, [{ id: "1", sql: "CREATE TABLE s (v TEXT DEFAULT 'a;b');\nINSERT INTO s DEFAULT VALUES;" }]);
    expect(await database.prepare("SELECT v FROM s").first("v")).toBe("a;b");
  });
});

describe("db() plugin", () => {
  test("decorates ctx.db", async () => {
    const database = await fresh();
    await database.prepare("INSERT INTO notes (body) VALUES (?)").bind("hello").run();
    const app = miu({
      plugins: [db({ database })],
      routes: [route.get("/n", { handler: async (ctx) => ({ body: await ctx.db.prepare("SELECT body FROM notes").first("body") }) })],
      logLevel: "silent",
    });
    const res = await app.fetch(new Request("http://localhost/n"));
    expect(await res.json()).toEqual({ body: "hello" });
  });

  test("defaults to an in-memory sqlite database locally", async () => {
    const app = miu({
      plugins: [db()],
      routes: [route.get("/n", { handler: async (ctx) => ({ one: await ctx.db.prepare("SELECT 1 AS one").first("one") }) })],
      logLevel: "silent",
    });
    expect(await (await app.fetch(new Request("http://localhost/n"))).json()).toEqual({ one: 1 });
  });

  test("resolves a d1 binding name from the request env", async () => {
    const database = await fresh();
    await database.prepare("INSERT INTO notes (body) VALUES (?)").bind("from-env").run();
    const app = miu({
      plugins: [db({ database: d1("DB") })],
      routes: [route.get("/n", { handler: async (ctx) => ({ body: await ctx.db.prepare("SELECT body FROM notes").first("body") }) })],
      logLevel: "silent",
    });
    const res = await app.dispatch(new Request("http://localhost/n"), { DB: database }, { runtime: "bun" });
    expect(await res.json()).toEqual({ body: "from-env" });
  });

  test("inspect() names the adapter; cloudflare() declares d1 bindings", () => {
    expect(db({ database: d1("MAIN") }).inspect()).toEqual({ adapter: "d1", binding: "MAIN" });
    expect(db({ database: d1("MAIN") }).cloudflare()).toEqual({ d1: ["MAIN"] });
    expect(db({ database: sqlite() }).inspect()).toEqual({ adapter: "sqlite", path: ":memory:" });
    expect(db({ database: sqlite() }).cloudflare()).toEqual({});
  });

  test("migrations option runs once before the first request", async () => {
    const app = miu({
      plugins: [db({ migrations: [{ id: "1", sql: "CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (7);" }] })],
      routes: [route.get("/n", { handler: async (ctx) => ({ x: await ctx.db.prepare("SELECT x FROM t").first("x") }) })],
      logLevel: "silent",
    });
    expect(await (await app.fetch(new Request("http://localhost/n"))).json()).toEqual({ x: 7 });
    expect(await (await app.fetch(new Request("http://localhost/n"))).json()).toEqual({ x: 7 });
  });
});

describe("sqlite() outside Bun", () => {
  test("throws MIU_E_DB_UNSUPPORTED with a fix on first use", async () => {
    const database = sqlite(":memory:", { runtime: "workerd" });
    let err: any;
    try {
      await database.prepare("SELECT 1").first();
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_DB_UNSUPPORTED");
    expect(err.fix).toContain("d1(");
  });
});
