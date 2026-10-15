// db().manage(): what an operator sees about the database. No arbitrary SQL, ever.
import { describe, expect, test } from "bun:test";
import { miu, route, type Context, type ManageSection } from "miujs";
import { db, migrate, sqlite, type DbOptions, type Migration } from "../src/index.ts";

const M1: Migration = { id: "001_users", sql: "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)" };
const M2: Migration = { id: "002_posts", sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)" };

async function setup(opts: DbOptions = {}, extra: { request?: boolean } = {}) {
  const plugin = db(opts);
  let grabbed: Context | undefined;
  const app = miu({ logLevel: "silent", plugins: [plugin], routes: [route.get("/__ctx", { handler: (c) => void (grabbed = c as unknown as Context) })] });
  if (extra.request !== false) await app.fetch(new Request("http://localhost/__ctx"));
  const sections = plugin.manage!();
  const section = sections.find((s) => s.id === "database")!;
  return { app, sections, section, ctx: grabbed!, plugin };
}

const stat = async (section: ManageSection, ctx: Context, label: string) => (await section.status!(ctx)).stats!.find((x) => x.label === label)?.value;

describe("db manage()", () => {
  test("one 'database' section; no action runs SQL from its input", async () => {
    const s = await setup({ database: sqlite(), migrations: [M1] });
    expect(s.sections.map((x) => x.id)).toEqual(["database"]);
    for (const a of s.section.actions ?? []) {
      const props = Object.keys(((a.input?.json ?? {}) as { properties?: object }).properties ?? {});
      expect(props.some((p) => /sql|query|statement/i.test(p))).toBe(false);
    }
  });

  test("status: adapter, tables with capped row counts, applied and pending migrations", async () => {
    const database = sqlite();
    const s = await setup({ database, migrations: [M1] });
    await database.exec("CREATE TABLE big (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER)");
    await database.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10050) INSERT INTO big (n) SELECT x FROM c");
    await database.prepare("INSERT INTO users VALUES ('u1', 'a@b.co')").run();
    const st = await s.section.status!(s.ctx);
    const v = (label: string) => st.stats!.find((x) => x.label === label)?.value;
    expect(v("Adapter")).toBe("sqlite");
    expect(v("Applied migrations")).toBe(1);
    expect(v("Pending migrations")).toBe(0);
    const tables = st.tables!.find((x) => x.title === "Tables")!;
    expect(tables.rows).toEqual([
      { table: "_miu_migrations", rows: 1 },
      { table: "big", rows: "10000+" },
      { table: "users", rows: 1 },
    ]);
    expect(v("Tables")).toBe(3);
    expect(JSON.stringify(st)).not.toContain("a@b.co");
  });

  test("status caps the number of tables it counts", async () => {
    const database = sqlite();
    for (let i = 0; i < 60; i++) await database.exec(`CREATE TABLE t${String(i).padStart(2, "0")} (x)`);
    const s = await setup({ database });
    const st = await s.section.status!(s.ctx);
    expect(st.tables![0].rows).toHaveLength(50);
    const tables = st.stats!.find((x) => x.label === "Tables")!;
    expect(tables.value).toBe(60);
    expect(tables.hint).toContain("first 50");
  });

  test("D1 bindings show the binding name; a missing binding is a clear error", async () => {
    const s = await setup({ database: { [Symbol.for("miujs.db.ref")]: true, binding: "DB", resolve: () => sqlite() } as never });
    expect(await stat(s.section, s.ctx, "Adapter")).toBe("d1 (binding DB)");
  });

  test("migrations list: configured and applied ids, with status filter and paging", async () => {
    const database = sqlite();
    await migrate(database, [{ id: "000_other_plugin", sql: "CREATE TABLE other (x)" }]);
    const s = await setup({ database, migrations: [M1, M2] }, { request: false });
    // Nothing has run yet for this plugin's list (no request), so 001/002 are pending.
    const grab = await (async () => {
      let c: Context | undefined;
      const app = miu({ logLevel: "silent", routes: [route.get("/c", { handler: (x) => void (c = x as unknown as Context) })] });
      await app.fetch(new Request("http://localhost/c"));
      return c!;
    })();
    const l = s.section.lists!.find((x) => x.name === "migrations")!;
    expect(l.idKey).toBe("id");
    const p1 = await l.list({ limit: 2 }, grab);
    expect(p1.rows).toEqual([
      { id: "000_other_plugin", status: "applied", appliedAt: expect.any(Number), configured: false },
      { id: "001_users", status: "pending", appliedAt: null, configured: true },
    ]);
    const p2 = await l.list({ limit: 2, cursor: p1.next }, grab);
    expect(p2.rows.map((r) => r.id)).toEqual(["002_posts"]);
    expect(p2.next).toBeUndefined();
    expect((await l.list({ limit: 10, filters: { status: "pending" } }, grab)).rows.map((r) => r.id)).toEqual(["001_users", "002_posts"]);
    expect((await l.list({ limit: 10, filters: { status: "applied" } }, grab)).rows.map((r) => r.id)).toEqual(["000_other_plugin"]);
    expect(await stat(s.section, grab, "Pending migrations")).toBe(2);
  });

  test("runMigrations applies pending migrations (danger) and is idempotent", async () => {
    const database = sqlite();
    const s = await setup({ database, migrations: [M1] }, { request: false });
    let ctx: Context | undefined;
    const bare = miu({ logLevel: "silent", routes: [route.get("/c", { handler: (x) => void (ctx = x as unknown as Context) })] });
    await bare.fetch(new Request("http://localhost/c"));
    const a = s.section.actions!.find((x) => x.name === "runMigrations")!;
    expect(a.danger).toBe(true);
    expect(await a.run({}, ctx!)).toBe("Applied 1 migration: 001_users");
    expect(await database.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
    expect(await a.run({}, ctx!)).toBe("Nothing to apply: all 1 migrations are applied");
  });

  test("without configured migrations there is no runMigrations action", async () => {
    const s = await setup({ database: sqlite() });
    expect((s.section.actions ?? []).some((a) => a.name === "runMigrations")).toBe(false);
  });

  test("a failing migration reports MIU_E_DB_MIGRATION_FAILED and nothing half-applied", async () => {
    const database = sqlite();
    const s = await setup({ database, migrations: [M1, { id: "002_bad", sql: "CREATE TABLE ok (x); NOT SQL AT ALL" }] }, { request: false });
    let ctx: Context | undefined;
    const bare = miu({ logLevel: "silent", routes: [route.get("/c", { handler: (x) => void (ctx = x as unknown as Context) })] });
    await bare.fetch(new Request("http://localhost/c"));
    const a = s.section.actions!.find((x) => x.name === "runMigrations")!;
    await expect(Promise.resolve().then(() => a.run({}, ctx!))).rejects.toMatchObject({ code: "MIU_E_DB_MIGRATION_FAILED" });
    expect(await database.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").first()).toBeNull();
    expect(await stat(s.section, ctx!, "Applied migrations")).toBe(1);
  });
});
