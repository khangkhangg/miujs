import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskBlobStore } from "../src/adapters/node.ts";
import { Miu } from "../src/core/app.ts";
import { serveBlob } from "../src/batteries/files/index.ts";
import { blobStoreContract } from "./batteries/files.test.ts";

const dirs: string[] = [];
const tempRoot = async () => {
  const d = await mkdtemp(join(tmpdir(), "miu-disk-"));
  dirs.push(d);
  return d;
};
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

blobStoreContract("disk", async () => diskBlobStore({ root: await tempRoot() }));

const text = (b: ReadableStream<Uint8Array>) => new Response(b).text();

describe("diskBlobStore", () => {
  test("persists across instances and uses the injected clock", async () => {
    const root = await tempRoot();
    const a = diskBlobStore({ root, now: () => 0 });
    const meta = await a.put("x/y.txt", "data", { contentType: "text/plain" });
    expect(meta.uploadedAt).toBe(new Date(0).toISOString());
    const b = diskBlobStore({ root });
    expect(await b.head("x/y.txt")).toEqual(meta);
    expect(await text((await b.get("x/y.txt"))!.body)).toBe("data");
  });

  test("a key and a key below it can coexist (no file/directory clash)", async () => {
    const s = diskBlobStore({ root: await tempRoot() });
    await s.put("a", "1");
    await s.put("a/b", "2");
    expect(await text((await s.get("a"))!.body)).toBe("1");
    expect(await text((await s.get("a/b"))!.body)).toBe("2");
    expect((await s.list()).items.map((i) => i.key)).toEqual(["a", "a/b"]);
  });

  test("overwrites atomically and leaves no temp or stale files (retainMs: 0)", async () => {
    const root = await tempRoot();
    const s = diskBlobStore({ root, retainMs: 0 });
    await s.put("k", "first");
    await s.put("k", "second, longer");
    expect(await text((await s.get("k"))!.body)).toBe("second, longer");
    expect((await s.head("k"))!.size).toBe(14);
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    await Bun.sleep(5); // retirement of the superseded data file is asynchronous
    expect((await readdir(join(root, "data"))).length).toBe(1);
    expect(await s.delete("k")).toBe(true);
    await Bun.sleep(5); // retirement is asynchronous even with retainMs: 0
    expect(await readdir(join(root, "data"))).toEqual([]);
  });

  test("superseded data is retained for retainMs so in-flight reads finish", async () => {
    const root = await tempRoot();
    const s = diskBlobStore({ root });
    await s.put("k", "first");
    await s.put("k", "second");
    expect((await readdir(join(root, "data"))).length).toBe(2);
  });

  test("an open read stream survives a concurrent overwrite", async () => {
    const s = diskBlobStore({ root: await tempRoot() });
    await s.put("k", "old content");
    const got = await s.get("k");
    await s.put("k", "new content");
    expect(await text(got!.body)).toBe("old content");
  });

  test("streams large bodies with ranges and matches the portable etag", async () => {
    const s = diskBlobStore({ root: await tempRoot() });
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const stream = new Blob([big]).stream();
    const meta = await s.put("big.bin", stream);
    const mem = await (await import("../src/batteries/files/index.ts")).memoryBlobStore().put("big.bin", big);
    expect(meta.etag).toBe(mem.etag);
    expect(meta.size).toBe(big.length);
    const part = new Uint8Array(await new Response((await s.get("big.bin", { range: { offset: 1_000_000, length: 10 } }))!.body).arrayBuffer());
    expect([...part]).toEqual([...big.subarray(1_000_000, 1_000_010)]);
  });

  test("refuses symlinks that escape the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret.json"), JSON.stringify({ file: "x", meta: {} }));
    const s = diskBlobStore({ root });
    await s.put("ok", "x"); // creates the layout
    await symlink(outside, join(root, "meta", "evil"));
    await symlink(outside, join(root, "data", "evil"));
    await expect(s.put("evil/a", "x")).rejects.toThrow(/outside/);
    await expect(s.head("evil/secret")).rejects.toThrow(/outside/);
    await expect(s.get("evil/secret")).rejects.toThrow(/outside/);
    expect((await s.list()).items.map((i) => i.key)).toEqual(["ok"]);
    expect(await readdir(outside)).toEqual(["secret.json"]);
  });

  test("ignores stray files in the metadata tree and rejects unsafe keys on every method", async () => {
    const root = await tempRoot();
    const s = diskBlobStore({ root });
    await s.put("a", "1");
    await mkdir(join(root, "meta", "junk"), { recursive: true });
    await writeFile(join(root, "meta", "junk", "notes.txt"), "x");
    expect((await s.list()).items.map((i) => i.key)).toEqual(["a"]);
    for (const bad of ["../x", "/abs", "a/./b"]) {
      await expect(s.get(bad)).rejects.toThrow();
      await expect(s.head(bad)).rejects.toThrow();
      await expect(s.delete(bad)).rejects.toThrow();
    }
  });

  test("serveBlob over disk: 206 and 304", async () => {
    const s = diskBlobStore({ root: await tempRoot() });
    const meta = await s.put("p.jpg", "0123456789", { contentType: "image/jpeg" });
    const app = new Miu({ logger: false }).get("/f/*", (c) => serveBlob(c, s, c.url.pathname.slice(3)));
    const r = await app.request("/f/p.jpg", { headers: { range: "bytes=3-5" } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe("345");
    expect((await app.request("/f/p.jpg", { headers: { "if-none-match": `"${meta.etag}"` } })).status).toBe(304);
  });
});
