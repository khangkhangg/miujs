import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "miujs";
import { _assertSqliteRuntime, defineJob, queue, sqliteQueue } from "../src/index.ts";
import { durableSuite } from "./durable-suite.ts";
import { queueSuite } from "./queue-suite.ts";

const dir = mkdtempSync(join(tmpdir(), "miu-queue-"));
let n = 0;
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold a WAL file briefly; the OS temp dir is cleaned eventually.
  }
});

queueSuite("sqlite queue", ({ clock, concurrency }) => {
  const sq = sqliteQueue(new Database(":memory:"), { clock, concurrency });
  return { adapter: sq, drain: () => sq.drain(), deadLetters: () => sq.listDeadLetters() };
});

// Each instance opens the same file, like two processes would.
durableSuite<string>(
  "sqlite queue",
  () => join(dir, `q${++n}.sqlite`),
  (path, o) => sqliteQueue(path, o),
);

describe("sqliteQueue specifics", () => {
  test("accepts an open bun:sqlite Database and creates its tables", async () => {
    const db = new Database(":memory:");
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    const q = queue({ jobs: [job], adapter: sqliteQueue(db) });
    await q.dispatch(job, {});
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'miu_jobs%' ORDER BY name").all();
    expect(tables).toEqual([{ name: "miu_jobs" }, { name: "miu_jobs_dead" }, { name: "miu_jobs_once" }]);
  });

  test("a custom table prefix", async () => {
    const db = new Database(":memory:");
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    await queue({ jobs: [job], adapter: sqliteQueue(db, { table: "work" }) }).dispatch(job, {});
    expect(db.query("SELECT count(*) AS n FROM work").get()).toEqual({ n: 1 });
    expect(() => sqliteQueue(db, { table: "bad name;" })).toThrow(expect.objectContaining({ code: "MIU_E_QUEUE_CONFIG" }) as any);
  });

  test("off Bun it fails with MIU_E_QUEUE_RUNTIME and a fix", () => {
    try {
      _assertSqliteRuntime("workerd");
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.code).toBe("MIU_E_QUEUE_RUNTIME");
      expect(e.fix).toContain("redisQueue");
    }
    expect(() => sqliteQueue(undefined as any)).toThrow(expect.objectContaining({ code: "MIU_E_QUEUE_CONFIG" }) as any);
  });

  test("inspect shows the path, not the database contents", () => {
    const p = join(dir, "inspect.sqlite");
    const sq = sqliteQueue(p);
    expect(sq.inspect!()).toMatchObject({ path: p, table: "miu_jobs", concurrency: 1 });
    sq.close();
  });
});
