// Memory, statement-cache and exit health of @miujs/db on sqlite: query loops, the db() plugin per
// request, migrateOnce, and close() releasing the file.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miu, route } from "miujs";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { db, migrateOnce, sqlite, type Migration } from "../src/index.ts";
import { drizzleFor } from "../src/drizzle.ts";

const PKG = join(import.meta.dir, "..");

async function seeded(path = ":memory:") {
  const database = sqlite(path);
  await database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'), ('b'), ('c')");
  return database;
}

describe("sqlite query loops do not leak", () => {
  const cases: [string, (d: Awaited<ReturnType<typeof seeded>>, i: number) => Promise<unknown>][] = [
    ["first()", (d, i) => d.prepare("SELECT name FROM t WHERE id = ?").bind((i % 3) + 1).first("name")],
    ["all()", (d) => d.prepare("SELECT * FROM t").all()],
    ["raw()", (d) => d.prepare("SELECT * FROM t").raw({ columnNames: true })],
    ["run()", (d, i) => d.prepare("UPDATE t SET name = ? WHERE id = 1").bind(`n${i % 10}`).run()],
    ["batch()", (d) => d.batch([d.prepare("SELECT count(*) AS n FROM t"), d.prepare("UPDATE t SET name = name WHERE id = 2")])],
    // Distinct SQL each time: the statement cache must stay bounded.
    ["many distinct statements", (d, i) => d.prepare(`SELECT ${i} AS n`).first("n")],
  ];
  for (const [name, fn] of cases) {
    test(name, async () => {
      const d = await seeded();
      const r = await leakCheck(name, (i) => fn(d, i), { perRound: 3000, rounds: 6, warmup: 1000 });
      await d.close();
      if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
      expect(r.leaking, describeLeak(r)).toBe(false);
    }, 60_000);
  }
});

test("migrateOnce with a fresh migrations array per call does not pile up", async () => {
  const d = sqlite();
  const r = await leakCheck("migrateOnce fresh arrays", () => migrateOnce(d, [{ id: "001", sql: "CREATE TABLE IF NOT EXISTS m (id INTEGER)" }]), {
    perRound: 2000,
    rounds: 6,
    warmup: 500,
  });
  await d.close();
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 60_000);

test("db() plugin (with drizzle) per request does not leak", async () => {
  const migrations: Migration[] = [{ id: "001", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a')" }];
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [db({ database: sqlite(), migrations, drizzle: {} })],
    routes: [route.get("/n", { handler: async ({ db }) => ({ n: await db.prepare("SELECT count(*) AS n FROM t").first("n") }) })],
  });
  await app.ready();
  const r = await leakCheck("db plugin request", async () => void (await (await app.fetch(new Request("http://x.test/n"))).arrayBuffer()), { perRound: 3000, rounds: 6, warmup: 1000 });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 60_000);

test("drizzleFor caches per database without holding closed databases", async () => {
  const r = await leakCheck("drizzleFor fresh databases", () => {
    const d = sqlite();
    drizzleFor(d);
    drizzleFor(d);
  }, { perRound: 2000, rounds: 6, warmup: 500 });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 60_000);

test("close() releases the file after many cached statements (Windows locks open files)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "miu-db-health-"));
  const d = await seeded(join(dir, "app.sqlite"));
  for (let i = 0; i < 500; i++) await d.prepare(`SELECT ${i % 250} AS n, name FROM t`).all();
  await d.prepare("SELECT * FROM t").raw();
  await d.close();
  rmSync(dir, { recursive: true });
  expect(existsSync(dir)).toBe(false);
});

test("a failing statement stays usable and the file still closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "miu-db-health-"));
  const d = await seeded(join(dir, "app.sqlite"));
  await expect(d.prepare("INSERT INTO t (id, name) VALUES (?, ?)").bind(1, "dup").run()).rejects.toThrow();
  expect((await d.prepare("INSERT INTO t (id, name) VALUES (?, ?)").bind(9, "ok").run()).meta.changes).toBe(1);
  // Schema changes re-prepare cached statements.
  await d.prepare("SELECT * FROM t").all();
  await d.exec("ALTER TABLE t ADD COLUMN extra TEXT");
  expect(Object.keys((await d.prepare("SELECT * FROM t").first<Record<string, unknown>>())!)).toContain("extra");
  await d.close();
  rmSync(dir, { recursive: true });
  expect(existsSync(dir)).toBe(false);
});

test("an app using db() exits after work, and after listen + stop", async () => {
  const r = await exitCheck(`
    import { miu, route } from "miujs";
    import { db, sqlite } from "../src/index.ts";
    const database = sqlite();
    const app = miu({ logLevel: "silent", plugins: [db({ database, migrations: [{ id: "1", sql: "CREATE TABLE t (id INTEGER)" }] })],
      routes: [route.get("/", { handler: async ({ db }) => db.prepare("SELECT count(*) AS n FROM t").first("n") })] });
    await app.ready();
    await (await app.fetch(new Request("http://x/"))).text();
    const s = await app.listen(0, "127.0.0.1");
    await (await fetch(s.url)).text();
    await s.stop();
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);
