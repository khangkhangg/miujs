import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { HttpError } from "../../src/core/errors.ts";
import { isEquirectangular, memoryBlobStore, uploadFiles, uploadRoute, type UploadOptions } from "../../src/batteries/files/index.ts";

function png(w: number, h: number) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

const post = (files: File[], field = "file") => {
  const fd = new FormData();
  for (const f of files) fd.append(field, f);
  return { method: "POST", body: fd };
};

const setup = (opts: UploadOptions = {}) => {
  const store = memoryBlobStore();
  const app = new Miu({ logger: false }).post("/upload", uploadRoute(store, opts));
  return { store, app };
};

type Problem = { status: number; code?: string; detail?: string; [k: string]: unknown };

describe("uploadRoute / uploadFiles", () => {
  test("stores a sniffed image under a generated key and returns its info (201)", async () => {
    const { store, app } = setup({ prefix: "panos" });
    const res = await app.request("/upload", post([new File([jpeg(4096, 2048)], "../../evil name.JPG", { type: "image/jpeg" })]));
    expect(res.status).toBe(201);
    const { files } = (await res.json()) as { files: { key: string; size: number; contentType: string; etag: string; width: number; height: number }[] };
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.key).toMatch(/^panos\/[A-Za-z0-9_-]{22}\.jpg$/);
    expect(f).toMatchObject({ size: jpeg(1, 1).length, contentType: "image/jpeg", width: 4096, height: 2048 });
    const meta = await store.head(f.key);
    expect(meta).toMatchObject({ contentType: "image/jpeg", etag: f.etag, size: f.size });
  });

  test("the stored type comes from the bytes, not the client (PNG declared as octet-stream)", async () => {
    const { store, app } = setup();
    const res = await app.request("/upload", post([new File([png(10, 10)], "x.bin", { type: "application/octet-stream" })]));
    expect(res.status).toBe(201);
    const { files } = (await res.json()) as { files: { key: string; contentType: string }[] };
    expect(files[0]!.contentType).toBe("image/png");
    expect(files[0]!.key).toMatch(/^uploads\/.+\.png$/);
    expect((await store.head(files[0]!.key))!.contentType).toBe("image/png");
  });

  test("a spoofed .jpg that is really text -> 415 with agent-readable details", async () => {
    const { store, app } = setup();
    const res = await app.request("/upload", post([new File(["<script>alert(1)</script>"], "cat.jpg", { type: "image/jpeg" })]));
    expect(res.status).toBe(415);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("file_type_mismatch");
    expect(body).toMatchObject({ declared: "image/jpeg", detected: "application/octet-stream", name: "cat.jpg" });
    expect((await store.list()).items).toHaveLength(0);
  });

  test("a real PNG declared as JPEG is a mismatch (415); a disallowed real type is 415", async () => {
    const { app } = setup({ allowed: ["image/jpeg"] });
    expect((await app.request("/upload", post([new File([png(10, 10)], "a.jpg", { type: "image/jpeg" })]))).status).toBe(415);
    const res = await app.request("/upload", post([new File([png(10, 10)], "a.png", { type: "image/png" })]));
    expect(res.status).toBe(415);
    expect(((await res.json()) as Problem).code).toBe("file_type_not_allowed");
  });

  test("oversize file -> 413 (per-file after parsing, and Content-Length before parsing)", async () => {
    const { app } = setup({ maxBytes: 40 });
    const big = new Uint8Array(100);
    big.set(png(10, 10));
    const res = await app.request("/upload", post([new File([big], "a.png", { type: "image/png" })]));
    expect(res.status).toBe(413);
    expect(((await res.json()) as Problem).code).toBe("file_too_large");

    const early = await app.request("/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(10 * 1024 * 1024) },
      body: "--x--",
    });
    expect(early.status).toBe(413);
    expect(((await early.json()) as Problem).code).toBe("request_too_large");
  });

  test("streams without Content-Length are capped too", async () => {
    const store = memoryBlobStore();
    const app = new Miu({ logger: false }).post("/upload", (c) => uploadFiles(c, store, { maxBytes: 10 }).then((files) => ({ files })));
    const chunk = new Uint8Array(64 * 1024);
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (n++ < 40) ctl.enqueue(chunk);
        else ctl.close();
      },
    });
    const req = new Request("http://x/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body, duplex: "half" } as RequestInit);
    expect((await app.fetch(req)).status).toBe(413);
  });

  test("non-2:1 panorama rejected via validate with isEquirectangular (422)", async () => {
    const { store, app } = setup({
      requireImage: true,
      validate: (info) => (info.image && isEquirectangular(info.image) ? undefined : "Panorama must be a 2:1 equirectangular image"),
    });
    const bad = await app.request("/upload", post([new File([jpeg(4000, 3000)], "p.jpg", { type: "image/jpeg" })]));
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as Problem;
    expect(body).toMatchObject({ code: "file_invalid", detail: "Panorama must be a 2:1 equirectangular image", name: "p.jpg" });
    expect((await store.list()).items).toHaveLength(0);
    expect((await app.request("/upload", post([new File([jpeg(4096, 2048)], "p.jpg", { type: "image/jpeg" })]))).status).toBe(201);
  });

  test("requireImage rejects allowed non-image types", async () => {
    const { app } = setup({ allowed: ["text/plain", "image/png"], requireImage: true });
    expect((await app.request("/upload", post([new File(["hi"], "a.txt", { type: "text/plain" })]))).status).toBe(415);
  });

  test("explicitly allowed unsniffable types keep their declared type with a mapped extension", async () => {
    const { store, app } = setup({ allowed: ["text/plain"] });
    const res = await app.request("/upload", post([new File(["hi"], "notes.txt", { type: "text/plain" })]));
    expect(res.status).toBe(201);
    const { files } = (await res.json()) as { files: { key: string; contentType: string }[] };
    expect(files[0]!.key).toEndWith(".txt");
    expect((await store.head(files[0]!.key))!.contentType).toBe("text/plain");
  });

  test("multiple files: limit enforced (400), all-or-nothing validation, custom key", async () => {
    const { store, app } = setup({ maxFiles: 2, key: (_file, info) => `t/${info.index}.${info.ext}` });
    const three = [1, 2, 3].map((i) => new File([png(i, i)], `${i}.png`, { type: "image/png" }));
    const res = await app.request("/upload", post(three));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("too_many_files");

    const mixed = [new File([png(1, 1)], "1.png", { type: "image/png" }), new File(["nope"], "2.png", { type: "image/png" })];
    expect((await app.request("/upload", post(mixed))).status).toBe(415);
    expect((await store.list()).items).toHaveLength(0);

    const ok = await app.request("/upload", post(three.slice(0, 2)));
    expect(ok.status).toBe(201);
    const { files } = (await ok.json()) as { files: { key: string; width: number }[] };
    expect(files.map((f) => [f.key, f.width])).toEqual([["t/0.png", 1], ["t/1.png", 2]]);
  });

  test("missing field / non-multipart body -> 400", async () => {
    const { app } = setup();
    const missing = await app.request("/upload", post([new File([png(1, 1)], "a.png", { type: "image/png" })], "other"));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as Problem).code).toBe("file_missing");
    const json = await app.request("/upload", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(400);
  });

  test("uploadFiles throws HttpError for direct use", async () => {
    const store = memoryBlobStore();
    const app = new Miu({ logger: false }).post("/u", async (c) => {
      try {
        await uploadFiles(c, store, {});
        return "ok";
      } catch (e) {
        return { http: e instanceof HttpError, status: (e as HttpError).status };
      }
    });
    expect(await (await app.request("/u", post([new File(["x"], "a.jpg", { type: "image/jpeg" })]))).json()).toEqual({ http: true, status: 415 });
  });

  test("the store can come from the request context", async () => {
    const store = memoryBlobStore();
    const app = new Miu({ logger: false }).post("/upload", uploadRoute(() => store));
    expect((await app.request("/upload", post([new File([png(2, 2)], "a.png", { type: "image/png" })]))).status).toBe(201);
    expect((await store.list("uploads/")).items).toHaveLength(1);
  });
});
