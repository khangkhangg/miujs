import { describe, expect, test } from "bun:test";
import { repositoryContract } from "../batteries/data.test.ts";
import { d1Repository } from "../../src/adapters/cloudflare/index.ts";
import { fakeD1 } from "./fakes.ts";

repositoryContract("d1", () => d1Repository(fakeD1(), { table: "scenes", searchFields: ["title"] }));

describe("d1Repository", () => {
  test("accepts a lazy binding getter and creates declared indexes", async () => {
    const d1 = fakeD1();
    const repo = d1Repository<{ id: string; tag: string }>(() => d1, { table: "items", indexes: ["tag"] });
    await repo.create({ tag: "x" });
    expect((await repo.list({ where: { tag: "x" } })).total).toBe(1);
    const idx = d1.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'items_tag'").all();
    expect(idx.length).toBe(1);
  });

  test("rejects unsafe identifiers", async () => {
    const repo = d1Repository<{ id: string }>(fakeD1(), { table: "items" });
    await expect(repo.list({ sort: "x) --" })).rejects.toThrow(/Invalid field/);
    expect(() => d1Repository(fakeD1(), { table: "a;b" })).toThrow(/Invalid table/);
  });
});
