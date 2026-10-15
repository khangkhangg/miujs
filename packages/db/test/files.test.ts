import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadMigrations, migrate, migrationsFromGlob, sqlite } from "../src/index.ts";

const ROOT = `${process.env.TEMP ?? "/tmp"}/miu-db-migrations-${Date.now()}`;
let n = 0;
function dir(files: Record<string, string>): string {
  const d = `${ROOT}/${n++}`;
  mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const path = `${d}/${name}`;
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, body);
  }
  return d;
}
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

async function codeOf(p: Promise<unknown>): Promise<{ code?: string; fix?: string }> {
  try {
    await p;
  } catch (e) {
    return e as any;
  }
  throw new Error("expected a rejection");
}

function codeOfSync(f: () => unknown): { code?: string; fix?: string } {
  try {
    f();
  } catch (e) {
    return e as any;
  }
  throw new Error("expected a throw");
}

describe("loadMigrations(dir)", () => {
  test("reads NNNN_name.sql files in numeric order; ids are the file names without .sql", async () => {
    const d = dir({
      "0010_tags.sql": "CREATE TABLE tags (id INTEGER);",
      "0002_posts.sql": "CREATE TABLE posts (id INTEGER);",
      "0001_users.sql": "CREATE TABLE users (id INTEGER);",
      "README.md": "not a migration",
      "meta/_journal.json": "{}",
    });
    const migrations = await loadMigrations(d);
    expect(migrations).toEqual([
      { id: "0001_users", sql: "CREATE TABLE users (id INTEGER);" },
      { id: "0002_posts", sql: "CREATE TABLE posts (id INTEGER);" },
      { id: "0010_tags", sql: "CREATE TABLE tags (id INTEGER);" },
    ]);
    const database = sqlite();
    expect(await migrate(database, migrations)).toEqual(["0001_users", "0002_posts", "0010_tags"]);
  });

  test("orders by number, not by string (9 before 10 even without padding)", async () => {
    const d = dir({ "10_b.sql": "SELECT 1", "9_a.sql": "SELECT 1" });
    expect((await loadMigrations(d)).map((m) => m.id)).toEqual(["9_a", "10_b"]);
  });

  test("an empty directory yields no migrations", async () => {
    expect(await loadMigrations(dir({}))).toEqual([]);
  });

  test("a missing directory throws MIU_E_DB_MIGRATIONS_DIR", async () => {
    const err = await codeOf(loadMigrations(`${ROOT}/does-not-exist`));
    expect(err.code).toBe("MIU_E_DB_MIGRATIONS_DIR");
    expect(err.fix).toContain("does-not-exist");
  });

  test("a .sql file without a number prefix is an error, not silently skipped", async () => {
    const err = await codeOf(loadMigrations(dir({ "0001_a.sql": "SELECT 1", "seed.sql": "SELECT 1" })));
    expect(err.code).toBe("MIU_E_DB_MIGRATION_NAME");
    expect(err.fix).toContain("seed.sql");
  });

  test("two files with the same number are an error", async () => {
    const err = await codeOf(loadMigrations(dir({ "0002_a.sql": "SELECT 1", "0002_b.sql": "SELECT 1" })));
    expect(err.code).toBe("MIU_E_DB_MIGRATION_DUPLICATE");
    expect(err.fix).toContain("0002_a.sql");
  });

  test("outside Bun/Node/Deno it explains how to bundle migrations instead", async () => {
    const err = await codeOf(loadMigrations("./migrations", { runtime: "workerd" }));
    expect(err.code).toBe("MIU_E_DB_UNSUPPORTED");
    expect(err.fix).toContain("migrationsFromGlob");
  });
});

describe("migrationsFromGlob(record)", () => {
  test("accepts bundled file contents keyed by path, sorted by number", () => {
    expect(
      migrationsFromGlob({
        "./migrations/0002_posts.sql": "CREATE TABLE posts (id INTEGER)",
        "/abs/path/migrations/0001_users.sql": "CREATE TABLE users (id INTEGER)",
        "0003_tags.sql": { default: "CREATE TABLE tags (id INTEGER)" },
      }),
    ).toEqual([
      { id: "0001_users", sql: "CREATE TABLE users (id INTEGER)" },
      { id: "0002_posts", sql: "CREATE TABLE posts (id INTEGER)" },
      { id: "0003_tags", sql: "CREATE TABLE tags (id INTEGER)" },
    ]);
  });

  test("Windows-style paths work too", () => {
    expect(migrationsFromGlob({ "migrations\\0001_a.sql": "SELECT 1" })).toEqual([{ id: "0001_a", sql: "SELECT 1" }]);
  });

  test("ignores non-.sql keys", () => {
    expect(migrationsFromGlob({ "0001_a.sql": "SELECT 1", "meta/_journal.json": "{}" })).toEqual([{ id: "0001_a", sql: "SELECT 1" }]);
  });

  test("same validation as loadMigrations", () => {
    expect(codeOfSync(() => migrationsFromGlob({ "x.sql": "SELECT 1" })).code).toBe("MIU_E_DB_MIGRATION_NAME");
    expect(codeOfSync(() => migrationsFromGlob({ "1_a.sql": "", "01_b.sql": "" })).code).toBe("MIU_E_DB_MIGRATION_DUPLICATE");
  });

  test("a non-text value explains how to import SQL as text", () => {
    const err = codeOfSync(() => migrationsFromGlob({ "0001_a.sql": 42 as any }));
    expect(err.code).toBe("MIU_E_DB_MIGRATION_INVALID");
    expect(err.fix).toContain("text");
  });

  test("feeds migrate() directly", async () => {
    const database = sqlite();
    const ids = await migrate(
      database,
      migrationsFromGlob({ "0001_t.sql": "CREATE TABLE t (x INTEGER);\nCREATE TRIGGER t_ins AFTER INSERT ON t BEGIN SELECT 1; SELECT 2; END;" }),
    );
    expect(ids).toEqual(["0001_t"]);
  });
});
