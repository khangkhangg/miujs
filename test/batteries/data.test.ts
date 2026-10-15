import { describe, expect, test } from "bun:test";
import { ConflictError, memoryRepository, type Repository } from "../../src/batteries/data/index.ts";

interface Scene { id: string; title: string; tourId: string; order: number; createdAt?: string; updatedAt?: string }

/** Contract every Repository driver must satisfy; other drivers import and run this. */
export function repositoryContract(name: string, make: () => Repository<Scene> | Promise<Repository<Scene>>) {
  describe(`Repository contract: ${name}`, () => {
    test("create assigns an id and timestamps; get returns it", async () => {
      const repo = await make();
      const s = await repo.create({ title: "Lobby", tourId: "t1", order: 1 });
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(8);
      expect(typeof s.createdAt).toBe("string");
      expect(await repo.get(s.id)).toEqual(s);
    });

    test("create keeps a caller-supplied id and rejects duplicates", async () => {
      const repo = await make();
      await repo.create({ id: "fixed", title: "A", tourId: "t1", order: 1 });
      expect((await repo.get("fixed"))?.title).toBe("A");
      await expect(repo.create({ id: "fixed", title: "B", tourId: "t1", order: 2 })).rejects.toThrow();
    });

    test("update merges a patch, bumps updatedAt, never changes id/createdAt", async () => {
      const repo = await make();
      const s = await repo.create({ title: "Lobby", tourId: "t1", order: 1 });
      const u = await repo.update(s.id, { title: "Hall", id: "hijack", createdAt: "x" } as Partial<Scene>);
      expect(u).toMatchObject({ id: s.id, title: "Hall", tourId: "t1", createdAt: s.createdAt });
      expect(await repo.update("missing", { title: "x" })).toBeUndefined();
    });

    test("delete reports existence", async () => {
      const repo = await make();
      const s = await repo.create({ title: "x", tourId: "t", order: 0 });
      expect(await repo.delete(s.id)).toBe(true);
      expect(await repo.delete(s.id)).toBe(false);
      expect(await repo.get(s.id)).toBeUndefined();
    });

    test("list filters with where, searches q across searchable fields, sorts and paginates", async () => {
      const repo = await make();
      for (const [i, title] of ["Kitchen", "Garden", "Garage", "Attic"].entries()) {
        await repo.create({ title, tourId: i < 3 ? "t1" : "t2", order: i });
      }
      const t1 = await repo.list({ where: { tourId: "t1" }, sort: "order" });
      expect(t1.total).toBe(3);
      expect(t1.items.map((s) => s.title)).toEqual(["Kitchen", "Garden", "Garage"]);
      const desc = await repo.list({ sort: "-order", limit: 2 });
      expect(desc.items.map((s) => s.title)).toEqual(["Attic", "Garage"]);
      expect(desc.total).toBe(4);
      const page2 = await repo.list({ sort: "order", limit: 2, offset: 2 });
      expect(page2.items.map((s) => s.title)).toEqual(["Garage", "Attic"]);
      const q = await repo.list({ q: "gar" });
      expect(q.items.map((s) => s.title).sort()).toEqual(["Garage", "Garden"]);
    });

    test("list caps limit at 1000 and defaults to 50", async () => {
      const repo = await make();
      for (let i = 0; i < 60; i++) await repo.create({ title: `s${i}`, tourId: "t", order: i });
      expect((await repo.list()).items.length).toBe(50);
      expect((await repo.list({ limit: 5000 })).items.length).toBe(60);
    });

    test("create with unique fields rejects a duplicate atomically (ConflictError, 409)", async () => {
      const repo = await make();
      await repo.create({ title: "Lobby", tourId: "t1", order: 1 }, { unique: ["title"] });
      const results = await Promise.allSettled([
        repo.create({ title: "Hall", tourId: "t1", order: 2 }, { unique: ["title"] }),
        repo.create({ title: "Hall", tourId: "t2", order: 3 }, { unique: ["title"] }),
        repo.create({ title: "Lobby", tourId: "t3", order: 4 }, { unique: ["title"] }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected", "rejected"]);
      const err = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect((await repo.list({ where: { title: "Hall" } })).total).toBe(1);
      // Without the option, duplicates are allowed (uniqueness is per call, not per table).
      await repo.create({ title: "Lobby", tourId: "t4", order: 5 });
    });

    test("update with unique fields rejects taking another document's value, allows keeping its own", async () => {
      const repo = await make();
      const a = await repo.create({ title: "A", tourId: "t", order: 1 });
      const b = await repo.create({ title: "B", tourId: "t", order: 2 });
      await expect(repo.update(b.id, { title: "A" }, { unique: ["title"] })).rejects.toBeInstanceOf(ConflictError);
      expect((await repo.get(b.id))?.title).toBe("B");
      expect((await repo.update(a.id, { title: "A", order: 9 }, { unique: ["title"] }))?.order).toBe(9);
      expect(await repo.update("missing", { title: "Z" }, { unique: ["title"] })).toBeUndefined();
    });

    test("list({ count: false }) skips counting and reports total as -1", async () => {
      const repo = await make();
      for (let i = 0; i < 3; i++) await repo.create({ title: `s${i}`, tourId: "t", order: i });
      const r = await repo.list({ where: { tourId: "t" }, sort: "order", limit: 2, count: false });
      expect(r.items.map((s) => s.title)).toEqual(["s0", "s1"]);
      expect(r.total).toBe(-1);
    });

    test("returned objects are copies (mutating them does not change stored data)", async () => {
      const repo = await make();
      const s = await repo.create({ title: "A", tourId: "t", order: 0 });
      s.title = "mutated";
      expect((await repo.get(s.id))?.title).toBe("A");
    });
  });
}

repositoryContract("memory", () => memoryRepository<Scene>({ searchFields: ["title"] }));
