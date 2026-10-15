// Memory, handle and exit health of @miujs/files: many uploads and downloads (including aborted
// and oversized ones) through miu().fetch on the memory and local stores.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { localStore, memoryStore, s3Store, type FileStore } from "../src/index.ts";
import { limitStream } from "../src/stream.ts";
import { openHandles } from "./handles.ts";
import { makeApp } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "miu-files-health-"));
  dirs.push(d);
  return d;
};

const payload = new Uint8Array(16 * 1024).map((_, i) => i & 0xff);

// Disk writes on the local store are slow (Windows especially): fewer, heavier iterations. Startup
// adds a few hundred JIT structures once, hence the looser object threshold.
const heavy = (store: string) =>
  store === "local" ? { perRound: 400, rounds: 6, warmup: 300, maxObjectsPerIteration: 0.25 } : { perRound: 2000, rounds: 6, warmup: 1000 };

async function setup(store: FileStore) {
  const t = makeApp({ store });
  const urls = await t.inCtx(async ({ files }) => ({
    put: await files.signedUrl("health/a.bin", { method: "PUT", expiresIn: 3600 }),
    get: await files.signedUrl("health/a.bin", { expiresIn: 3600 }),
  }));
  const res = await t.req(urls.put, { method: "PUT", body: payload, headers: { "content-type": "application/octet-stream" } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  return { ...t, urls };
}

const stores: [string, () => FileStore][] = [
  ["memory", () => memoryStore()],
  ["local", () => localStore(tempDir())],
];

describe.each(stores)("files on the %s store do not leak", (name, make) => {
  test("upload + download", async () => {
    const t = await setup(make());
    const r = await leakCheck(`${name} upload+download`, async () => {
      const up = await t.req(t.urls.put, { method: "PUT", body: payload });
      await up.arrayBuffer();
      const down = await t.req(t.urls.get);
      await down.arrayBuffer();
    }, heavy(name));
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("downloads cancelled after the first chunk", async () => {
    const t = await setup(make());
    const r = await leakCheck(`${name} aborted download`, async () => {
      const down = await t.req(t.urls.get);
      const reader = down.body!.getReader();
      await reader.read();
      await reader.cancel();
    }, { perRound: 2000, rounds: 6, warmup: 1000 });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("range downloads", async () => {
    const t = await setup(make());
    const r = await leakCheck(`${name} range`, async () => {
      const down = await t.req(t.urls.get, { headers: { range: "bytes=100-4195" } });
      expect(down.status).toBe(206);
      expect((await down.arrayBuffer()).byteLength).toBe(4096);
    }, { perRound: 2000, rounds: 6, warmup: 1000 });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("uploads whose body fails mid-way leave nothing behind", async () => {
    const store = make();
    const t = await setup(store);
    const r = await leakCheck(`${name} failed upload`, async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(payload);
        },
        pull(c) {
          c.error(new Error("client went away"));
        },
      });
      const res = await t.req(t.urls.put, { method: "PUT", body, duplex: "half" } as RequestInit);
      expect(res.status).toBeGreaterThanOrEqual(400);
      await res.arrayBuffer();
    }, heavy(name));
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
    if (name === "local") {
      const tmp = join((store.inspect!() as { dir: string }).dir, "tmp");
      expect(readdirSync(tmp)).toEqual([]);
    }
  }, 120_000);
});

test("cancelled local downloads close their file handles", async () => {
  const t = await setup(localStore(tempDir()));
  const cancelAfterFirstChunk = async () => {
    const down = await t.req(t.urls.get);
    const reader = down.body!.getReader();
    await reader.read();
    await reader.cancel();
  };
  for (let i = 0; i < 20; i++) await cancelAfterFirstChunk();
  const before = openHandles();
  if (before === null) return; // not measurable on this OS
  for (let i = 0; i < 300; i++) await cancelAfterFirstChunk();
  const after = openHandles()!;
  expect(after - before).toBeLessThan(50);
}, 60_000);

test("an oversized upload cancels its source instead of reading it", async () => {
  let pulled = 0;
  let cancelled = false;
  const src = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const limited = limitStream(src, 4096);
  await expect(new Response(limited).arrayBuffer()).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(10);
});

test("abandoned multipart uploads on the memory store do not pile up", async () => {
  const store = memoryStore();
  const part = new Uint8Array(4096);
  const r = await leakCheck("abandoned multipart", async () => {
    const id = await store.createMultipart("big/model.glb");
    await store.uploadPart("big/model.glb", id, 1, new Response(part).body!);
  }, { perRound: 1000, rounds: 5, warmup: 2000, maxBytesPerIteration: 256 });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 120_000);

test("an S3 server that ignores Range is not read past the range", async () => {
  const size = 8 * 1024 * 1024;
  let sent = 0;
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") {
      // A server that ignores the Range header and streams the whole object.
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent >= size) return c.close();
          c.enqueue(new Uint8Array(64 * 1024));
          sent += 64 * 1024;
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": String(size), etag: '"e"', "content-type": "application/octet-stream" } });
    }
    return new Response(null, { status: 200 });
  };
  const store = s3Store({ bucket: "b", region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", endpoint: "https://s3.test", fetch: fakeFetch as any });
  const obj = await store.get("k", { range: { offset: 10, length: 100 } });
  expect(obj!.range).toEqual({ offset: 10, length: 100 });
  expect((await new Response(obj!.body).arrayBuffer()).byteLength).toBe(100);
  expect(sent).toBeLessThan(size / 4);
});

test("an app using files() exits after work", async () => {
  const r = await exitCheck(`
    import { miu } from "miujs";
    import { files, localStore } from "../src/index.ts";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const dir = mkdtempSync(join(tmpdir(), "miu-files-exit-"));
    const plugin = files({ secret: "x".repeat(40), store: localStore(dir) });
    const app = miu({ logLevel: "silent", plugins: [plugin] });
    await app.ready();
    const svc = app.service("files");
    await svc.put("a.txt", "hello");
    const url = await svc.signedUrl("a.txt");
    const res = await app.fetch(new Request(new URL(url, "http://x.test")));
    await res.text();
    const s = await app.listen(0, "127.0.0.1");
    const half = await fetch(new URL(url, s.url));
    await half.body!.cancel();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);

describe("local store releases the upload body when the disk write fails", () => {
  const source = () => {
    const s = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        // Not bytes: the file write rejects it, like a disk error mid-upload.
        c.enqueue({ byteLength: 10 } as unknown as Uint8Array);
      },
      cancel() {
        s.cancelled = true;
      },
    });
    return { s, stream };
  };

  test("a write error mid-stream cancels the body and removes the temp file", async () => {
    const dir = tempDir();
    const { s, stream } = source();
    await expect(localStore(dir).put("a.bin", stream)).rejects.toThrow();
    expect(s.cancelled).toBe(true);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  test("a temp folder that cannot be created cancels the body", async () => {
    const dir = tempDir();
    await Bun.write(join(dir, "tmp"), "not a folder");
    const { s, stream } = source();
    await expect(localStore(dir).put("a.bin", stream)).rejects.toThrow();
    expect(s.cancelled).toBe(true);
  });
});
