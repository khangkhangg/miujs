import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite } from "../src/index.ts";

test("close() releases the file so it can be deleted (Windows locks open files)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "miu-db-close-"));
  const db = sqlite(join(dir, "app.sqlite"));
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  await db.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run();
  expect(await db.prepare("SELECT name FROM t").first("name")).toBe("a");
  expect((await db.prepare("SELECT * FROM t").all()).results).toHaveLength(1);
  expect(await db.prepare("SELECT name FROM t").raw()).toEqual([["a"]]);
  await db.batch([db.prepare("INSERT INTO t (name) VALUES (?)").bind("b"), db.prepare("SELECT count(*) AS n FROM t")]);
  await db.close();
  rmSync(dir, { recursive: true });
  expect(existsSync(dir)).toBe(false);
});

test("close() is idempotent, works before first use, and later use fails with a fix", async () => {
  const never = sqlite();
  await never.close();
  await never.close();

  const db = sqlite();
  await db.exec("CREATE TABLE t (id INTEGER)");
  await db.close();
  await db.close();
  await expect(db.prepare("SELECT 1").all()).rejects.toMatchObject({ code: "MIU_E_DB_CLOSED" });
  await expect(db.exec("SELECT 1")).rejects.toMatchObject({ code: "MIU_E_DB_CLOSED" });
});
