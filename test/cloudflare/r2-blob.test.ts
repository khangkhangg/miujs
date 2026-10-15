import { describe, expect, test } from "bun:test";
import { r2BlobStore, r2Files } from "../../src/adapters/cloudflare/index.ts";
import { Miu } from "../../src/core/app.ts";
import { serveBlob, uploadRoute } from "../../src/batteries/files/index.ts";
import { blobStoreContract } from "../batteries/files.test.ts";
import { fakeR2 } from "./fakes.ts";

blobStoreContract("r2", () => r2BlobStore(fakeR2()));

describe("r2BlobStore", () => {
  test("maps to R2 http/custom metadata and accepts a binding getter", async () => {
    const bucket = fakeR2();
    const s = r2BlobStore(() => bucket);
    const meta = await s.put("a.png", "x", { contentType: "image/png", metadata: { owner: "u1" } });
    const obj = bucket.objects.get("a.png")!.meta;
    expect(obj.httpMetadata?.contentType).toBe("image/png");
    expect(obj.customMetadata).toEqual({ owner: "u1" });
    expect(meta).toEqual({ key: "a.png", size: 1, contentType: "image/png", etag: obj.etag, uploadedAt: new Date(0).toISOString(), metadata: { owner: "u1" } });
  });

  test("buffers unknown-length streams (R2 requires a known length)", async () => {
    const bucket = fakeR2();
    const puts: unknown[] = [];
    const s = r2BlobStore({ ...bucket, put: (k, v, o) => (puts.push(v), bucket.put(k, v, o)) });
    await s.put("s", new Response("stream").body!);
    expect(puts[0]).toBeInstanceOf(Uint8Array);
  });

  test("works with serveBlob and uploadRoute", async () => {
    const bucket = fakeR2();
    const s = r2BlobStore(bucket);
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 8);
    new DataView(png.buffer).setUint32(20, 4);
    const app = new Miu({ logger: false })
      .post("/upload", uploadRoute(s))
      .get("/f/*", (c) => serveBlob(c, s, c.url.pathname.slice(3)));
    const fd = new FormData();
    fd.append("file", new File([png], "a.png", { type: "image/png" }));
    const up = await app.request("/upload", { method: "POST", body: fd });
    expect(up.status).toBe(201);
    const { files } = (await up.json()) as { files: { key: string; etag: string }[] };
    const res = await app.request(`/f/${files[0]!.key}`, { headers: { range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("etag")).toBe(`"${files[0]!.etag}"`);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("r2Files.serve shares serveBlob's hardening", () => {
  test("nosniff everywhere; SVG as a sandboxed attachment unless allowed", async () => {
    const files = r2Files(fakeR2());
    await files.put("u/x.svg", "<svg onload=alert(1)>", { contentType: "image/svg+xml" });
    await files.put("u/a.png", "png", { contentType: "image/png" });
    const app = new Miu({ logger: false })
      .get("/f/*", (c) => files.serve(c, c.url.pathname.slice(3)))
      .get("/trusted/*", (c) => files.serve(c, c.url.pathname.slice(9), { allowActiveContent: true }));
    const svg = await app.request("/f/u/x.svg");
    expect(svg.headers.get("content-security-policy")).toBe("sandbox");
    expect(svg.headers.get("content-disposition")).toStartWith('attachment; filename="x.svg"');
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    const png = await app.request("/f/u/a.png");
    expect(png.headers.get("content-disposition")).toBeNull();
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await app.request("/trusted/u/x.svg")).headers.get("content-security-policy")).toBeNull();
  });
});
