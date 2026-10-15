import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { memoryBlobStore, serveBlob, type BlobStore } from "../../src/batteries/files/index.ts";

const setup = async (opts: Parameters<typeof serveBlob>[3] = {}) => {
  const store = memoryBlobStore();
  await store.put("docs/a.txt", "hello world", { contentType: "text/plain" });
  const app = new Miu({ logger: false }).get("/f/*", (c) => serveBlob(c, store, c.url.pathname.slice(3), opts));
  return { store, app };
};

describe("serveBlob", () => {
  test("200 with content-type, etag, length, accept-ranges, nosniff and no-cache default", async () => {
    const { store, app } = await setup();
    const meta = await store.head("docs/a.txt");
    const res = await app.request("/f/docs/a.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("etag")).toBe(`"${meta!.etag}"`);
    expect(res.headers.get("content-length")).toBe("11");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  test("404 problem+json for missing or unsafe keys", async () => {
    const { app } = await setup();
    for (const p of ["/f/nope", "/f/a/%2e%2e/%2e%2e/etc"]) {
      const res = await app.request(p);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
    }
  });

  test("If-None-Match -> 304 (lists, weak and *), mismatch -> 200", async () => {
    const { store, app } = await setup();
    const etag = (await store.head("docs/a.txt"))!.etag;
    for (const inm of [`"${etag}"`, `W/"${etag}"`, `"x", "${etag}"`, "*"]) {
      const res = await app.request("/f/docs/a.txt", { headers: { "if-none-match": inm } });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(`"${etag}"`);
      expect(await res.text()).toBe("");
    }
    expect((await app.request("/f/docs/a.txt", { headers: { "if-none-match": '"other"' } })).status).toBe(200);
  });

  test("single Range -> 206 with content-range; unsatisfiable -> 416; others ignored", async () => {
    const { app } = await setup();
    const cases: [string, string, string][] = [
      ["bytes=0-4", "hello", "bytes 0-4/11"],
      ["bytes=6-", "world", "bytes 6-10/11"],
      ["bytes=-3", "rld", "bytes 8-10/11"],
      ["bytes=6-100", "world", "bytes 6-10/11"],
    ];
    for (const [range, body, cr] of cases) {
      const res = await app.request("/f/docs/a.txt", { headers: { range } });
      expect(res.status).toBe(206);
      expect(await res.text()).toBe(body);
      expect(res.headers.get("content-range")).toBe(cr);
      expect(res.headers.get("content-length")).toBe(String(body.length));
    }
    for (const range of ["bytes=50-60", "bytes=11-", "bytes=-0"]) {
      const bad = await app.request("/f/docs/a.txt", { headers: { range } });
      expect(bad.status).toBe(416);
      expect(bad.headers.get("content-range")).toBe("bytes */11");
    }
    for (const range of ["lines=1-2", "bytes=0-1,3-4", "bytes=5-2"]) {
      expect((await app.request("/f/docs/a.txt", { headers: { range } })).status).toBe(200);
    }
  });

  test("HEAD returns headers only", async () => {
    const { app } = await setup();
    const res = await app.request("/f/docs/a.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("11");
    expect(await res.text()).toBe("");
  });

  test("active content (SVG, HTML, XML, JS) is served as attachment with CSP sandbox", async () => {
    const store = memoryBlobStore();
    const types = ["image/svg+xml", "text/html; charset=utf-8", "application/xhtml+xml", "text/xml", "application/xml", "text/javascript", "application/javascript", "application/rss+xml"];
    for (const [i, t] of types.entries()) await store.put(`x/${i}`, "<svg onload=alert(1)>", { contentType: t });
    const app = new Miu({ logger: false }).get("/f/*", (c) => serveBlob(c, store, c.url.pathname.slice(3)));
    for (const i of types.keys()) {
      const res = await app.request(`/f/x/${i}`);
      expect(res.headers.get("content-disposition")).toStartWith("attachment");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const allowed = new Miu({ logger: false }).get("/f/*", (c) => serveBlob(c, store, c.url.pathname.slice(3), { allowActiveContent: true }));
    const res = await allowed.request("/f/x/0");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("download filename and cache-control override", async () => {
    const { app } = await setup({ download: 'my "report"\r\n.txt', cacheControl: "public, max-age=60" });
    const res = await app.request("/f/docs/a.txt");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const cd = res.headers.get("content-disposition")!;
    expect(cd).toStartWith("attachment;");
    expect(cd).not.toContain("\r");
    expect(cd).toContain(`filename="my _report_.txt"`);
    expect(cd).toContain("filename*=UTF-8''my%20%22report%22.txt");
  });

  test("works with any BlobStore (head + ranged get)", async () => {
    const inner = memoryBlobStore();
    const calls: string[] = [];
    const store: BlobStore = {
      ...inner,
      get: (k, o) => (calls.push(`get:${o?.range ? `${o.range.offset}+${o.range.length}` : "all"}`), inner.get(k, o)),
      head: (k) => (calls.push("head"), inner.head(k)),
    };
    await inner.put("k", "0123456789");
    const app = new Miu({ logger: false }).get("/f/*", (c) => serveBlob(c, store, c.url.pathname.slice(3)));
    expect(await (await app.request("/f/k", { headers: { range: "bytes=2-3" } })).text()).toBe("23");
    expect(calls).toEqual(["head", "get:2+2"]);
  });
});
