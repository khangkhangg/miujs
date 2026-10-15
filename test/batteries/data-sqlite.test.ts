import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryContract } from "./data.test.ts";
import { sqliteRepository } from "../../src/sqlite.ts";
import { openDatabase } from "../../src/batteries/sqlite.ts";

interface Item { id: string; title?: string; n?: number; flag?: boolean; tag?: string | null; meta?: { a: number }; createdAt?: string; updatedAt?: string }

repositoryContract("sqlite", () => sqliteRepository({ path: ":memory:", table: "scenes", searchFields: ["title"] }));

describe("sqliteRepository", () => {
  test("persists JSON documents to a file across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miu-repo-"));
    try {
      const path = join(dir, "data.sqlite");
      const a = sqliteRepository<Item>({ path, table: "items" });
      const doc = await a.create({ title: "Hello", meta: { a: 1 } });
      const b = sqliteRepository<Item>({ path, table: "items" });
      expect(await b.get(doc.id)).toEqual(doc);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("where handles numbers, booleans and null with JSON types (no string/number confusion)", async () => {
    const repo = sqliteRepository<Item>({ path: ":memory:", table: "items" });
    await repo.create({ title: "a", n: 5, flag: true, tag: null });
    await repo.create({ title: "b", n: 6, flag: false, tag: "x" });
    expect((await repo.list({ where: { n: 5 } })).items.map((d) => d.title)).toEqual(["a"]);
    expect((await repo.list({ where: { n: "5" } })).total).toBe(0);
    expect((await repo.list({ where: { flag: true } })).items.map((d) => d.title)).toEqual(["a"]);
    expect((await repo.list({ where: { flag: false } })).items.map((d) => d.title)).toEqual(["b"]);
    expect((await repo.list({ where: { tag: null } })).items.map((d) => d.title)).toEqual(["a"]);
  });

  test("q without searchFields searches string values, not keys", async () => {
    const repo = sqliteRepository<Item>({ path: ":memory:", table: "items" });
    await repo.create({ title: "Kitchen" });
    await repo.create({ title: "Garden", tag: "Kit" });
    expect((await repo.list({ q: "kit" })).total).toBe(2);
    expect((await repo.list({ q: "title" })).total).toBe(0);
  });

  test("q treats LIKE wildcards literally", async () => {
    const repo = sqliteRepository<Item>({ path: ":memory:", table: "items", searchFields: ["title"] });
    await repo.create({ title: "100% done" });
    await repo.create({ title: "1000 done" });
    expect((await repo.list({ q: "0%" })).items.map((d) => d.title)).toEqual(["100% done"]);
    expect((await repo.list({ q: "_" })).total).toBe(0);
  });

  test("sorts by createdAt/updatedAt/id columns and puts missing values last", async () => {
    const repo = sqliteRepository<Item>({ path: ":memory:", table: "items" });
    await repo.create({ id: "b", title: "x", n: 2 });
    await repo.create({ id: "a", title: "y" });
    await repo.create({ id: "c", title: "z", n: 1 });
    expect((await repo.list({ sort: "id" })).items.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect((await repo.list({ sort: "-createdAt" })).items.length).toBe(3);
    expect((await repo.list({ sort: "n" })).items.map((d) => d.id)).toEqual(["c", "b", "a"]);
  });

  test("rejects unsafe field names in where and sort (no SQL injection)", async () => {
    const repo = sqliteRepository<Item>({ path: ":memory:", table: "items" });
    await expect(repo.list({ sort: "title; DROP TABLE items" })).rejects.toThrow(/Invalid field/);
    await expect(repo.list({ where: { "x') OR 1=1 --": 1 } })).rejects.toThrow(/Invalid field/);
    await expect(repo.update("x", { ["a'b" as "title"]: "v" })).rejects.toThrow(/Invalid field/);
    expect(() => sqliteRepository({ path: ":memory:", table: "bad name" })).toThrow(/Invalid table/);
  });

  test("update replaces nested objects (shallow merge) and undefined removes a field", async () => {
    const repo = sqliteRepository<Item>({ path: ":memory:", table: "items" });
    const d = await repo.create({ title: "t", meta: { a: 1 }, tag: "x" });
    const u = await repo.update(d.id, { meta: { a: 2 }, tag: undefined });
    expect(u?.meta).toEqual({ a: 2 });
    expect("tag" in (u ?? {})).toBe(false);
    expect(await repo.get(d.id)).toEqual(u!);
  });

  test("declared indexes become JSON expression indexes", async () => {
    const db = await openDatabase(":memory:");
    const repo = sqliteRepository<Item>({ db, table: "items", indexes: ["tag", "n"] });
    await repo.list();
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items' ORDER BY name").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["items_n", "items_tag"]));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM items WHERE json_extract(data, '$.tag') = ?").all("x") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("items_tag");
  });
});
