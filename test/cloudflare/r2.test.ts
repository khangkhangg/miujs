import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { r2Files, uploadHandler } from "../../src/adapters/cloudflare/r2.ts";
import { fakeR2 } from "./fakes.ts";

const setup = async () => {
  const bucket = fakeR2();
  const files = r2Files(bucket);
  await files.put("docs/a.txt", "hello world", { contentType: "text/plain", metadata: { owner: "u1" } });
  const app = new Miu({ logger: false }).get("/files/*", (c) => files.serve(c, c.url.pathname.slice("/files/".length)));
  return { bucket, files, app };
};

describe("r2Files", () => {
  test("put/get/delete/list", async () => {
    const { files } = await setup();
    await files.put("docs/b.txt", new Uint8Array([1, 2, 3]));
    await files.put("img/c.png", "x", { contentType: "image/png" });
    const a = await files.get("docs/a.txt");
    expect(await a!.text()).toBe("hello world");
    expect(a!.httpMetadata?.contentType).toBe("text/plain");
    expect(a!.customMetadata).toEqual({ owner: "u1" });
    expect((await files.list("docs/")).objects.map((o) => o.key)).toEqual(["docs/a.txt", "docs/b.txt"]);
    await files.delete("docs/a.txt");
    expect(await files.get("docs/a.txt")).toBeNull();
  });

  test("serve returns the body with content-type, etag and cache-control", async () => {
    const { app } = await setup();
    const res = await app.request("/files/docs/a.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("etag")).toBe('"etag1"');
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("11");
  });

  test("serve honors If-None-Match with 304", async () => {
    const { app } = await setup();
    const res = await app.request("/files/docs/a.txt", { headers: { "if-none-match": '"etag1"' } });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"etag1"');
    expect(await res.text()).toBe("");
    const miss = await app.request("/files/docs/a.txt", { headers: { "if-none-match": '"other"' } });
    expect(miss.status).toBe(200);
  });

  test("serve honors Range with 206", async () => {
    const { app } = await setup();
    const r1 = await app.request("/files/docs/a.txt", { headers: { range: "bytes=0-4" } });
    expect(r1.status).toBe(206);
    expect(await r1.text()).toBe("hello");
    expect(r1.headers.get("content-range")).toBe("bytes 0-4/11");
    const r2 = await app.request("/files/docs/a.txt", { headers: { range: "bytes=6-" } });
    expect(await r2.text()).toBe("world");
    expect(r2.headers.get("content-range")).toBe("bytes 6-10/11");
    const r3 = await app.request("/files/docs/a.txt", { headers: { range: "bytes=-3" } });
    expect(await r3.text()).toBe("rld");
    expect(r3.headers.get("content-range")).toBe("bytes 8-10/11");
    const bad = await app.request("/files/docs/a.txt", { headers: { range: "bytes=50-60" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */11");
    const ignored = await app.request("/files/docs/a.txt", { headers: { range: "lines=1-2" } });
    expect(ignored.status).toBe(200);
  });

  test("serve 404s for a missing key and allows cache-control override", async () => {
    const { files } = await setup();
    const app = new Miu({ logger: false }).get("/f/:key", (c) => files.serve(c, c.params.key!, { cacheControl: "public, max-age=60" }));
    expect((await app.request("/f/missing")).status).toBe(404);
    await files.put("k", "v");
    expect((await app.request("/f/k")).headers.get("cache-control")).toBe("public, max-age=60");
  });
});

describe("uploadHandler", () => {
  const form = (file: File, field = "file") => {
    const fd = new FormData();
    fd.append(field, file);
    return { method: "POST", body: fd };
  };

  const setupUpload = () => {
    const bucket = fakeR2();
    const app = new Miu({ logger: false }).post(
      "/upload",
      uploadHandler({
        bucket: () => bucket,
        maxBytes: 10,
        allowedTypes: ["image/*", "text/plain"],
        key: (file, c) => `u/${c.req.headers.get("x-user")}/${file.name}`,
      }),
    );
    return { bucket, app };
  };

  test("stores the file and returns 201 with its key", async () => {
    const { bucket, app } = setupUpload();
    const res = await app.request("/upload", { ...form(new File(["hi"], "a.txt", { type: "text/plain" })), headers: { "x-user": "u1" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ key: "u/u1/a.txt", size: 2, etag: "etag1" });
    expect(bucket.objects.get("u/u1/a.txt")?.meta.httpMetadata?.contentType).toStartWith("text/plain");
  });

  test("rejects oversize (413), disallowed type (415) and missing file (400)", async () => {
    const { bucket, app } = setupUpload();
    expect((await app.request("/upload", form(new File(["x".repeat(11)], "big.txt", { type: "text/plain" })))).status).toBe(413);
    expect((await app.request("/upload", form(new File(["x"], "a.pdf", { type: "application/pdf" })))).status).toBe(415);
    expect((await app.request("/upload", form(new File(["x"], "a.png", { type: "image/png" }), "other"))).status).toBe(400);
    expect((await app.request("/upload", { method: "POST", body: "nope", headers: { "content-type": "text/plain" } })).status).toBe(400);
    expect(bucket.objects.size).toBe(0);
  });

  test("default key is a random id that keeps the file extension", async () => {
    const bucket = fakeR2();
    const app = new Miu({ logger: false }).post("/upload", uploadHandler({ bucket }));
    const res = await app.request("/upload", form(new File(["png"], "Photo.PNG", { type: "image/png" })));
    const { key } = (await res.json()) as { key: string };
    expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
  });
});
