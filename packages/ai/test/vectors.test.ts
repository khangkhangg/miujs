import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { sqlite } from "../../db/src/index.ts";
import { cosine, memoryVectors, sqliteVectors, vectorize, type VectorStore } from "../src/vectors.ts";

const contract = (name: string, make: () => VectorStore) =>
  describe(`${name} store contract`, () => {
    test("returns the nearest vectors first, with cosine scores and metadata", async () => {
      const s = make();
      await s.upsert([
        { id: "x", values: [1, 0, 0], metadata: { text: "about x", kind: "a" } },
        { id: "y", values: [0, 1, 0], metadata: { text: "about y", kind: "b" } },
        { id: "xy", values: [1, 1, 0], metadata: { text: "both", kind: "a" } },
      ]);
      const out = await s.query([1, 0.1, 0], { topK: 2 });
      expect(out.map((m) => m.id)).toEqual(["x", "xy"]);
      expect(out[0].score).toBeCloseTo(cosine([1, 0.1, 0], [1, 0, 0]), 5);
      expect(out[0].metadata).toEqual({ text: "about x", kind: "a" });
    });

    test("upsert replaces by id; delete removes", async () => {
      const s = make();
      await s.upsert([{ id: "a", values: [1, 0] }, { id: "b", values: [0, 1] }]);
      await s.upsert([{ id: "a", values: [0, 1], metadata: { v: 2 } }]);
      let out = await s.query([0, 1], { topK: 5 });
      expect(out.length).toBe(2);
      expect(out.find((m) => m.id === "a")!.score).toBeCloseTo(1, 5);
      await s.delete(["b"]);
      out = await s.query([0, 1], { topK: 5 });
      expect(out.map((m) => m.id)).toEqual(["a"]);
    });

    test("filters on metadata equality", async () => {
      const s = make();
      await s.upsert([
        { id: "1", values: [1, 0], metadata: { kind: "a" } },
        { id: "2", values: [1, 0.01], metadata: { kind: "b" } },
      ]);
      expect((await s.query([1, 0], { topK: 5, filter: { kind: "b" } })).map((m) => m.id)).toEqual(["2"]);
    });

    test("defaults to topK 4", async () => {
      const s = make();
      await s.upsert(Array.from({ length: 6 }, (_, i) => ({ id: String(i), values: [1, i] })));
      expect((await s.query([1, 0])).length).toBe(4);
    });
  });

contract("memoryVectors()", () => memoryVectors());
contract("sqliteVectors()", () => sqliteVectors(sqlite()));

describe("cosine()", () => {
  test("is 1 for parallel, 0 for orthogonal, 0 for zero vectors", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("sqliteVectors()", () => {
  test("persists float32 blobs in a table other stores can reopen", async () => {
    const db = sqlite();
    await sqliteVectors(db, { table: "docs_vec" }).upsert([{ id: "a", values: [0.25, -0.5], metadata: { text: "hi" } }]);
    const row: any = await db.prepare("SELECT dims, embedding FROM docs_vec WHERE id = ?").bind("a").first();
    expect(row.dims).toBe(2);
    expect(Array.from(new Float32Array(new Uint8Array(row.embedding).buffer))).toEqual([0.25, -0.5]);
    const out = await sqliteVectors(db, { table: "docs_vec" }).query([0.25, -0.5]);
    expect(out[0]).toMatchObject({ id: "a", metadata: { text: "hi" } });
  });

  test("rejects unsafe table names", () => {
    try {
      sqliteVectors(sqlite(), { table: "x; drop table y" });
      throw new Error("should fail");
    } catch (e) {
      expect(isMiuError(e) && e.code).toBe("MIU_E_AI_CONFIG");
    }
  });
});

describe("vectorize()", () => {
  function fakeVectorize() {
    const upserts: unknown[] = [];
    const queries: unknown[] = [];
    const deletes: unknown[] = [];
    return {
      upserts,
      queries,
      deletes,
      async upsert(v: unknown[]) {
        upserts.push(v);
        return { mutationId: "m" };
      },
      async query(v: number[], o: unknown) {
        queries.push([v, o]);
        return { count: 1, matches: [{ id: "doc1", score: 0.9, metadata: { text: "hello" } }] };
      },
      async deleteByIds(ids: string[]) {
        deletes.push(ids);
        return { mutationId: "d" };
      },
    };
  }

  test("resolves the binding from env and maps upsert/query/delete", async () => {
    const VEC = fakeVectorize();
    const s = vectorize("VEC").forEnv!({ VEC });
    await s.upsert([{ id: "doc1", values: [1, 2], metadata: { text: "hello" } }]);
    const out = await s.query([1, 2], { topK: 3, filter: { kind: "a" } });
    await s.delete(["doc1"]);
    expect(VEC.upserts[0]).toEqual([{ id: "doc1", values: [1, 2], metadata: { text: "hello" } }]);
    expect(VEC.queries[0]).toEqual([[1, 2], { topK: 3, returnMetadata: "all", filter: { kind: "a" } }]);
    expect(VEC.deletes[0]).toEqual(["doc1"]);
    expect(out).toEqual([{ id: "doc1", score: 0.9, metadata: { text: "hello" } }]);
    expect(vectorize("VEC").inspect!()).toEqual({ adapter: "vectorize", binding: "VEC" });
  });

  test("a missing binding fails with MIU_E_AI_BINDING", async () => {
    try {
      await vectorize("VEC").forEnv!({}).query([1]);
      throw new Error("should fail");
    } catch (e) {
      expect(isMiuError(e) && e.code).toBe("MIU_E_AI_BINDING");
    }
  });

  test("accepts a binding object directly", async () => {
    const VEC = fakeVectorize();
    expect((await vectorize(VEC).query([1])).length).toBe(1);
  });
});
