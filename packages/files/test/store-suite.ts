// The contract every FileStore must meet. Each store's test file runs it.
import { expect, test } from "bun:test";
import type { FileStore } from "../src/store.ts";
import { collect, toStream } from "../src/stream.ts";
import { str, text } from "./fixtures.ts";

const s = (v: string) => toStream(v);

export function failing(after: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(text(after));
      } else c.error(new Error("client went away"));
    },
  });
}

export function storeSuite(make: () => FileStore | Promise<FileStore>) {
  test("put then get returns body, size, type, etag and metadata", async () => {
    const st = await make();
    const info = await st.put("a/b.txt", s("hello"), { contentType: "text/plain", metadata: { owner: "u1" } });
    expect(info).toMatchObject({ key: "a/b.txt", size: 5, contentType: "text/plain", metadata: { owner: "u1" } });
    expect(info.etag).toBeTruthy();
    expect(info.uploaded).toBeInstanceOf(Date);
    const got = (await st.get("a/b.txt"))!;
    expect(str(await collect(got.body))).toBe("hello");
    expect(got).toMatchObject({ size: 5, contentType: "text/plain", etag: info.etag, metadata: { owner: "u1" } });
  });

  test("default content type is application/octet-stream", async () => {
    const st = await make();
    expect((await st.put("x", s("1"))).contentType).toBe("application/octet-stream");
  });

  test("missing keys: get and head return null, delete is a no-op", async () => {
    const st = await make();
    expect(await st.get("nope")).toBeNull();
    expect(await st.head("nope")).toBeNull();
    await st.delete("nope");
  });

  test("head returns info without a body", async () => {
    const st = await make();
    const info = await st.put("h", s("abc"));
    const h = (await st.head("h"))!;
    expect(h).toMatchObject({ key: "h", size: 3, etag: info.etag });
    expect((h as any).body).toBeUndefined();
  });

  test("overwrite changes the etag", async () => {
    const st = await make();
    const a = await st.put("k", s("one"));
    const b = await st.put("k", s("two!"));
    expect(b.etag).not.toBe(a.etag);
    expect(str(await collect((await st.get("k"))!.body))).toBe("two!");
    expect((await st.head("k"))!.size).toBe(4);
  });

  test("range reads", async () => {
    const st = await make();
    await st.put("r", s("0123456789"));
    const got = (await st.get("r", { range: { offset: 2, length: 3 } }))!;
    expect(str(await collect(got.body))).toBe("234");
    expect(got.size).toBe(10);
    expect(got.range).toEqual({ offset: 2, length: 3 });
  });

  test("delete removes the object", async () => {
    const st = await make();
    await st.put("d/x", s("1"));
    await st.delete("d/x");
    expect(await st.get("d/x")).toBeNull();
  });

  test("a body stream that errors stores nothing (and keeps the previous version)", async () => {
    const st = await make();
    await expect(st.put("f", failing("partial"))).rejects.toThrow();
    expect(await st.head("f")).toBeNull();
    await st.put("g", s("old"));
    await expect(st.put("g", failing("new"))).rejects.toThrow();
    expect(str(await collect((await st.get("g"))!.body))).toBe("old");
  });

  test("list by prefix, sorted, paginated with a cursor", async () => {
    const st = await make();
    for (const k of ["p/c", "p/a", "q/z", "p/b/1", "p/d"]) await st.put(k, s(k));
    const page1 = await st.list({ prefix: "p/", limit: 2 });
    expect(page1.files.map((f) => f.key)).toEqual(["p/a", "p/b/1"]);
    expect(page1.cursor).toBeTruthy();
    const page2 = await st.list({ prefix: "p/", limit: 2, cursor: page1.cursor });
    expect(page2.files.map((f) => f.key)).toEqual(["p/c", "p/d"]);
    if (page2.cursor) {
      const page3 = await st.list({ prefix: "p/", limit: 2, cursor: page2.cursor });
      expect(page3.files).toEqual([]);
      expect(page3.cursor).toBeUndefined();
    }
    const all = await st.list();
    expect(all.files.map((f) => f.key)).toEqual(["p/a", "p/b/1", "p/c", "p/d", "q/z"]);
    expect(all.cursor).toBeUndefined();
    expect(all.files[0]).toMatchObject({ size: 3 });
  });

  test("multipart: parts joined in order, with type and metadata", async () => {
    const st = await make();
    const id = await st.createMultipart("big.glb", { contentType: "model/gltf-binary", metadata: { by: "u1" } });
    const p2 = await st.uploadPart("big.glb", id, 2, s("world"), 5);
    const p1 = await st.uploadPart("big.glb", id, 1, s("hello "), 6);
    expect(p1.partNumber).toBe(1);
    expect(await st.head("big.glb")).toBeNull();
    const info = await st.completeMultipart("big.glb", id, [p1, p2]);
    expect(info).toMatchObject({ key: "big.glb", size: 11, contentType: "model/gltf-binary", metadata: { by: "u1" } });
    expect(str(await collect((await st.get("big.glb"))!.body))).toBe("hello world");
  });

  test("multipart: re-uploading a part replaces it", async () => {
    const st = await make();
    const id = await st.createMultipart("m");
    await st.uploadPart("m", id, 1, s("xxxx"), 4);
    const p1 = await st.uploadPart("m", id, 1, s("ab"), 2);
    await st.completeMultipart("m", id, [p1]);
    expect(str(await collect((await st.get("m"))!.body))).toBe("ab");
  });

  test("multipart: a wrong part etag is rejected", async () => {
    const st = await make();
    const id = await st.createMultipart("m2");
    await st.uploadPart("m2", id, 1, s("ab"), 2);
    await expect(st.completeMultipart("m2", id, [{ partNumber: 1, etag: "bogus" }])).rejects.toThrow();
    expect(await st.head("m2")).toBeNull();
  });

  test("multipart: abort discards the upload", async () => {
    const st = await make();
    const id = await st.createMultipart("m3");
    const p = await st.uploadPart("m3", id, 1, s("ab"), 2);
    await st.abortMultipart("m3", id);
    await expect(st.completeMultipart("m3", id, [p])).rejects.toThrow();
    expect(await st.head("m3")).toBeNull();
  });

  test("multipart: an unknown upload id is rejected", async () => {
    const st = await make();
    await expect(st.uploadPart("m4", "0123456789abcdef0123456789abcdef", 1, s("x"), 1)).rejects.toThrow();
  });
}
