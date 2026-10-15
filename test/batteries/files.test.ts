import { describe, expect, test } from "bun:test";
import { memoryBlobStore, type BlobStore } from "../../src/batteries/files/index.ts";

const text = async (b: ReadableStream<Uint8Array>) => new Response(b).text();

/** Contract every BlobStore driver must satisfy; other drivers import and run this. */
export function blobStoreContract(name: string, make: () => BlobStore | Promise<BlobStore>) {
  describe(`BlobStore contract: ${name}`, () => {
    test("put/get/head round-trip with metadata and a stable etag", async () => {
      const s = await make();
      const meta = await s.put("tours/t1/pano.jpg", new TextEncoder().encode("hello"), {
        contentType: "image/jpeg",
        metadata: { scene: "lobby" },
      });
      expect(meta).toMatchObject({ key: "tours/t1/pano.jpg", size: 5, contentType: "image/jpeg", metadata: { scene: "lobby" } });
      expect(typeof meta.etag).toBe("string");
      const got = await s.get("tours/t1/pano.jpg");
      expect(got!.meta).toEqual(meta);
      expect(await text(got!.body)).toBe("hello");
      expect(await s.head("tours/t1/pano.jpg")).toEqual(meta);
    });

    test("accepts string, Blob, ArrayBuffer and ReadableStream bodies", async () => {
      const s = await make();
      await s.put("a", "str");
      await s.put("b", new Blob(["blob"]));
      await s.put("c", new TextEncoder().encode("ab").buffer as ArrayBuffer);
      await s.put("d", new Response("stream").body!);
      expect(await text((await s.get("a"))!.body)).toBe("str");
      expect(await text((await s.get("b"))!.body)).toBe("blob");
      expect(await text((await s.get("c"))!.body)).toBe("ab");
      expect(await text((await s.get("d"))!.body)).toBe("stream");
    });

    test("ranged reads", async () => {
      const s = await make();
      await s.put("r", "0123456789");
      expect(await text((await s.get("r", { range: { offset: 2, length: 3 } }))!.body)).toBe("234");
      expect(await text((await s.get("r", { range: { offset: 7 } }))!.body)).toBe("789");
    });

    test("missing keys", async () => {
      const s = await make();
      expect(await s.get("nope")).toBeUndefined();
      expect(await s.head("nope")).toBeUndefined();
      expect(await s.delete("nope")).toBe(false);
    });

    test("delete and list by prefix with pagination", async () => {
      const s = await make();
      for (const k of ["t1/a", "t1/b", "t1/c", "t2/a"]) await s.put(k, k);
      expect(await s.delete("t1/b")).toBe(true);
      const page1 = await s.list("t1/", { limit: 1 });
      expect(page1.items.map((i) => i.key)).toEqual(["t1/a"]);
      const page2 = await s.list("t1/", { limit: 1, cursor: page1.cursor });
      expect(page2.items.map((i) => i.key)).toEqual(["t1/c"]);
      expect(page2.cursor).toBeUndefined();
    });

    test("rejects unsafe keys (path traversal, absolute, empty, control chars)", async () => {
      const s = await make();
      for (const bad of ["../etc/passwd", "a/../../b", "/abs", "", "a\u0000b", "a\\b"]) {
        await expect(s.put(bad, "x")).rejects.toThrow();
      }
    });
  });
}

blobStoreContract("memory", () => memoryBlobStore());
