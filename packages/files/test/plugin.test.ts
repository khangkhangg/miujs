import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { files, localStore, memoryStore, r2Store } from "../src/index.ts";
import { collect } from "../src/stream.ts";
import { str } from "./fixtures.ts";
import { errorCode, makeApp, SECRET } from "./helpers.ts";

describe("ctx.files basics", () => {
  test("put, get, head, list, delete", async () => {
    const { inCtx } = makeApp();
    const out = await inCtx(async ({ files }) => {
      const put = await files.put("docs/a.txt", "hello", { contentType: "text/plain", metadata: { owner: "u1" } });
      const got = (await files.get("docs/a.txt"))!;
      const body = str(await collect(got.body));
      const head = await files.head("docs/a.txt");
      const list = await files.list({ prefix: "docs/" });
      await files.delete("docs/a.txt");
      return { put, got, body, head, list, after: await files.get("docs/a.txt") };
    });
    expect(out.put).toMatchObject({ key: "docs/a.txt", size: 5, contentType: "text/plain" });
    expect(out.body).toBe("hello");
    expect(out.got).toMatchObject({ size: 5, contentType: "text/plain", etag: out.put.etag, metadata: { owner: "u1" } });
    expect(out.head?.size).toBe(5);
    expect(out.list.files.map((f) => f.key)).toEqual(["docs/a.txt"]);
    expect(out.after).toBeNull();
  });

  test("get with a range; length defaults to the rest of the file", async () => {
    const { inCtx } = makeApp();
    const out = await inCtx(async ({ files }) => {
      await files.put("r", "0123456789");
      const a = (await files.get("r", { range: { offset: 3, length: 2 } }))!;
      const b = (await files.get("r", { range: { offset: 7 } }))!;
      return [str(await collect(a.body)), a.size, str(await collect(b.body)), b.range];
    });
    expect(out).toEqual(["34", 10, "789", { offset: 7, length: 3 }]);
  });

  test("put accepts bytes, blobs and streams", async () => {
    const { inCtx } = makeApp();
    const sizes = await inCtx(async ({ files }) => [
      (await files.put("a", new Uint8Array([1, 2, 3]))).size,
      (await files.put("b", new Blob(["abcd"]))).size,
      (await files.put("c", new Response("xy").body!)).size,
    ]);
    expect(sizes).toEqual([3, 4, 2]);
  });

  test("invalid keys are rejected before reaching the store", async () => {
    const { inCtx } = makeApp();
    await expect(inCtx(({ files }) => files.put("../x", "1"))).rejects.toMatchObject({ code: "MIU_E_FILES_KEY_INVALID" });
    await expect(inCtx(({ files }) => files.get("/etc/passwd"))).rejects.toMatchObject({ code: "MIU_E_FILES_KEY_INVALID" });
  });

  test("list limit is validated", async () => {
    const { inCtx } = makeApp();
    await expect(inCtx(({ files }) => files.list({ limit: 0 }))).rejects.toMatchObject({ code: "MIU_E_FILES_CONFIG" });
  });
});

describe("signedUrl + GET route", () => {
  test("serves the file at the plugin's own route", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("img/a.png", "PNGDATA", { contentType: "image/png" });
      return files.signedUrl("img/a.png");
    });
    expect(url).toStartWith("http://app.test/_files/");
    const res = await req(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNGDATA");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("7");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toMatch(/^"[^"]+"$/);
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  test("Cache-Control is private and matches the remaining lifetime", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a", { expiresIn: 120 });
    });
    const cc = (await req(url)).headers.get("cache-control")!;
    const age = Number(cc.match(/^private, max-age=(\d+)$/)![1]);
    expect(age).toBeGreaterThan(115);
    expect(age).toBeLessThanOrEqual(120);
  });

  test("basePath and publicUrl options", async () => {
    const { inCtx, req } = makeApp({ basePath: "/media", publicUrl: "https://cdn.example.com/" });
    const url = await inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a");
    });
    expect(url).toStartWith("https://cdn.example.com/media/");
    expect((await req(new URL(url).pathname)).status).toBe(200);
  });

  test("download sets a safe Content-Disposition", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("r.pdf", "%PDF", { contentType: "application/pdf" });
      return files.signedUrl("r.pdf", { download: 'Báo cáo "Q3"\r\n.pdf' });
    });
    const cd = (await req(url)).headers.get("content-disposition")!;
    expect(cd).toStartWith("attachment;");
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toContain(`filename="Bao cao Q3.pdf"`);
    expect(cd).toContain("filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20Q3.pdf");
  });

  test("active content (html, svg) is never served inline", async () => {
    const { inCtx, req } = makeApp();
    const urls = await inCtx(async ({ files }) => {
      await files.put("x.html", "<script>alert(1)</script>", { contentType: "text/html" });
      await files.put("x.svg", "<svg/>", { contentType: "image/svg+xml" });
      return [await files.signedUrl("x.html"), await files.signedUrl("x.svg")];
    });
    for (const u of urls) {
      const res = await req(u);
      expect(res.headers.get("content-disposition")).toStartWith("attachment");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
    }
  });

  test("a missing file is 404", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(({ files }) => files.signedUrl("ghost"));
    const res = await req(url);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("MIU_E_FILES_NOT_FOUND");
  });

  test("a tampered token is 403", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a");
    });
    const res = await req(url.slice(0, -2) + (url.endsWith("AA") ? "BB" : "AA"));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("a URL signed with another secret is refused", async () => {
    const a = makeApp();
    const b = makeApp({ secret: "another-secret-".padEnd(40, "y"), store: a.store });
    const url = await b.inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a");
    });
    expect((await a.req(url)).status).toBe(403);
  });

  test("an expired URL is 403 TOKEN_EXPIRED", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a", { expiresIn: 1 });
    });
    const realNow = Date.now;
    Date.now = () => realNow() + 5000;
    try {
      const res = await req(url);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("MIU_E_FILES_TOKEN_EXPIRED");
    } finally {
      Date.now = realNow;
    }
  });

  test("a PUT URL cannot be used to read, and a GET URL cannot be used to write", async () => {
    const { inCtx, req } = makeApp();
    const [getUrl, putUrl] = await inCtx(async ({ files }) => {
      await files.put("a", "x");
      return [await files.signedUrl("a"), await files.signedUrl("a", { method: "PUT" })];
    });
    expect((await req(putUrl)).status).toBe(403);
    expect((await req(getUrl, { method: "PUT", body: "evil" })).status).toBe(403);
  });

  test("signedUrl validates its options", async () => {
    const { inCtx } = makeApp();
    for (const o of [{ expiresIn: 0 }, { expiresIn: 8 * 86400 }, { expiresIn: 1.5 }, { method: "DELETE" }, { method: "GET", maxSize: 10 }, { method: "PUT", download: "a.txt" }, { method: "PUT", maxSize: -1 }]) {
      await expect(inCtx(({ files }) => files.signedUrl("a", o as any))).rejects.toMatchObject({ code: "MIU_E_FILES_CONFIG" });
    }
    await expect(inCtx(({ files }) => files.signedUrl("../a"))).rejects.toMatchObject({ code: "MIU_E_FILES_KEY_INVALID" });
  });

  test("HEAD returns headers without a body", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("a", "hello");
      return files.signedUrl("a");
    });
    const res = await req(url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(await res.text()).toBe("");
  });

  test("file routes are not MCP tools", () => {
    const app = miu({ plugins: [files({ secret: SECRET, store: memoryStore() })], mcp: true, logLevel: "silent" });
    return app.ready().then(() => {
      expect(app.inspect().mcp!.tools).toEqual([]);
    });
  });
});

describe("conditional and range requests", () => {
  async function setup() {
    const t = makeApp();
    const url = await t.inCtx(async ({ files }) => {
      await files.put("v.mp4", "0123456789", { contentType: "video/mp4" });
      return files.signedUrl("v.mp4");
    });
    const etag = (await t.req(url)).headers.get("etag")!;
    return { ...t, url, etag };
  }

  test("If-None-Match with the current ETag is 304", async () => {
    const { req, url, etag } = await setup();
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = await req(url, { headers: { "if-none-match": inm } });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toStartWith("private");
      expect(await res.text()).toBe("");
    }
    expect((await req(url, { headers: { "if-none-match": '"stale"' } })).status).toBe(200);
  });

  test.each([
    ["bytes=0-3", "0123", "bytes 0-3/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-2", "89", "bytes 8-9/10"],
    ["bytes=8-100", "89", "bytes 8-9/10"],
    ["bytes=-50", "0123456789", "bytes 0-9/10"],
  ])("Range %s is 206", async (range, body, contentRange) => {
    const { req, url } = await setup();
    const res = await req(url, { headers: { range } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("content-range")).toBe(contentRange);
    expect(res.headers.get("content-length")).toBe(String(body.length));
    expect(res.headers.get("content-type")).toBe("video/mp4");
  });

  test.each(["bytes=10-", "bytes=20-30", "bytes=-0"])("unsatisfiable Range %s is 416", async (range) => {
    const { req, url } = await setup();
    const res = await req(url, { headers: { range } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  test.each(["items=0-1", "bytes=3-1", "bytes=a-b", "bytes=0-1,4-5"])("Range %s that cannot be served as one range is ignored (200)", async (range) => {
    const { req, url } = await setup();
    const res = await req(url, { headers: { range } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  test("If-Range with a stale ETag serves the whole file", async () => {
    const { req, url, etag } = await setup();
    expect((await req(url, { headers: { range: "bytes=0-1", "if-range": etag } })).status).toBe(206);
    const res = await req(url, { headers: { range: "bytes=0-1", "if-range": '"old"' } });
    expect(res.status).toBe(200);
  });
});

describe("signed PUT uploads", () => {
  test("uploads to the signed key", async () => {
    const { inCtx, req, store } = makeApp();
    const url = await inCtx(({ files }) => files.signedUrl("u/a.bin", { method: "PUT" }));
    const res = await req(url, { method: "PUT", body: "uploaded!", headers: { "content-type": "application/octet-stream" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: "u/a.bin", size: 9 });
    expect(str(await collect((await store.get("u/a.bin"))!.body))).toBe("uploaded!");
  });

  test("enforces the signed content type", async () => {
    const { inCtx, req, store } = makeApp();
    const url = await inCtx(({ files }) => files.signedUrl("p.png", { method: "PUT", contentType: "image/png" }));
    const bad = await req(url, { method: "PUT", body: "<html>", headers: { "content-type": "text/html" } });
    expect(bad.status).toBe(415);
    expect(await errorCode(bad)).toBe("MIU_E_FILES_TYPE_NOT_ALLOWED");
    expect(await store.head("p.png")).toBeNull();
    const ok = await req(url, { method: "PUT", body: "png", headers: { "content-type": "image/png; charset=binary" } });
    expect(ok.status).toBe(200);
    expect((await store.head("p.png"))!.contentType).toBe("image/png");
  });

  test("rejects a declared Content-Length over maxSize before reading", async () => {
    const { inCtx, req, store } = makeApp();
    const url = await inCtx(({ files }) => files.signedUrl("big", { method: "PUT", maxSize: 4 }));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(5));
        c.close();
      },
    }, { highWaterMark: 0 });
    const res = await req(url, { method: "PUT", body, headers: { "content-length": "5" }, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("MIU_E_FILES_TOO_LARGE");
    expect(pulled).toBe(0);
    expect(await store.head("big")).toBeNull();
  });

  test("streams and aborts once maxSize is passed, even without Content-Length", async () => {
    const { inCtx, req, store } = makeApp();
    const url = await inCtx(({ files }) => files.signedUrl("big", { method: "PUT", maxSize: 1000 }));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 1000) c.close();
        else c.enqueue(new Uint8Array(100));
      },
    });
    const res = await req(url, { method: "PUT", body, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(50);
    expect(await store.head("big")).toBeNull();
  });

  test("the plugin-wide maxUploadSize applies when the URL has no maxSize", async () => {
    const { inCtx, req } = makeApp({ maxUploadSize: 3 });
    const url = await inCtx(({ files }) => files.signedUrl("x", { method: "PUT" }));
    expect((await req(url, { method: "PUT", body: "1234" })).status).toBe(413);
  });

  test("an expired PUT URL is refused", async () => {
    const { inCtx, req, store } = makeApp();
    const url = await inCtx(({ files }) => files.signedUrl("x", { method: "PUT", expiresIn: 1 }));
    const realNow = Date.now;
    Date.now = () => realNow() + 5000;
    try {
      expect((await req(url, { method: "PUT", body: "1" })).status).toBe(403);
    } finally {
      Date.now = realNow;
    }
    expect(await store.head("x")).toBeNull();
  });
});

describe("secrets", () => {
  const sign = (t: ReturnType<typeof makeApp>, env: Record<string, unknown>) => t.inCtx(({ files }) => files.signedUrl("a"), { env });

  test("uses env.FILES_SECRET, then env.SESSION_SECRET", async () => {
    const t = makeApp({ secret: undefined });
    const s1 = "f".repeat(32);
    const s2 = "g".repeat(32);
    const a = await sign(t, { FILES_SECRET: s1, SESSION_SECRET: s2 });
    const b = await sign(t, { SESSION_SECRET: s1 });
    const c = await sign(t, { SESSION_SECRET: s2 });
    expect(a.split("/").pop()!.split(".")[1]).toBe(b.split("/").pop()!.split(".")[1]);
    expect(b).not.toBe(c);
  });

  test("a secret shorter than 32 chars is refused", async () => {
    const t = makeApp({ secret: "short" });
    await expect(t.inCtx(({ files }) => files.signedUrl("a"))).rejects.toMatchObject({ code: "MIU_E_FILES_SECRET_WEAK" });
    const u = makeApp({ secret: undefined });
    await expect(sign(u, { FILES_SECRET: "short" })).rejects.toMatchObject({ code: "MIU_E_FILES_SECRET_WEAK" });
  });

  test("in production a missing secret is SECRET_MISSING with a fix", async () => {
    const t = makeApp({ secret: undefined }, { dev: false });
    try {
      await sign(t, {});
      throw new Error("did not throw");
    } catch (err: any) {
      expect(err.code).toBe("MIU_E_FILES_SECRET_MISSING");
      expect(err.fix).toContain("FILES_SECRET");
    }
  });

  test("in dev a missing secret falls back to a random one, with one warning", async () => {
    const warnings: string[] = [];
    const t = makeApp({ secret: undefined, onWarning: (m) => warnings.push(m) });
    const url = await t.inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a");
    }, { env: {} });
    await t.inCtx(({ files }) => files.signedUrl("a"), { env: {} });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("FILES_SECRET");
    expect((await t.req(url, {}, {})).status).toBe(200);
  });

  test("secrets rotate: the first signs, all verify", async () => {
    const old = "o".repeat(32);
    const a = makeApp({ secret: old });
    const b = makeApp({ secret: ["n".repeat(32), old], store: a.store });
    const url = await a.inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a");
    });
    expect((await b.req(url)).status).toBe(200);
  });
});

describe("store defaults, inspect and cloudflare", () => {
  test("memoryStore by default in dev", async () => {
    const app = miu({ routes: [], plugins: [files({ secret: SECRET })], logLevel: "silent", dev: true });
    await app.ready();
    expect((app.inspect().plugins[0].info as any).store).toBe("memory");
  });

  test("no store in production is a config error at startup", async () => {
    const app = miu({ plugins: [files({ secret: SECRET })], logLevel: "silent", dev: false });
    await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_FILES_STORE_MISSING" });
  });

  test("inspect reports the store kind and basePath, never the secret", () => {
    const info = files({ secret: SECRET, store: localStore("./data/files"), basePath: "/media" }).inspect!() as any;
    expect(info).toMatchObject({ store: "local", basePath: "/media", dir: "./data/files", multipart: true });
    expect(JSON.stringify(info)).not.toContain(SECRET);
    expect(info.secret).toBe("(option)");
    expect((files({ store: memoryStore() }).inspect!() as any).secret).toBe("env.FILES_SECRET or env.SESSION_SECRET");
  });

  test("cloudflare() declares the R2 binding for r2Store(name)", () => {
    expect(files({ store: r2Store("FILES") }).cloudflare!()).toEqual({ r2: ["FILES"] });
    expect(files({ store: memoryStore() }).cloudflare!()).toEqual({});
  });

  test("basePath is validated", () => {
    for (const basePath of ["files", "/files/", "/a/:b", "/"]) {
      expect(() => files({ basePath })).toThrow();
    }
  });

  test("r2Store(name) is resolved from the request env", async () => {
    const { fakeR2 } = await import("./fake-r2.ts");
    const bucket = fakeR2();
    const t = makeApp({ store: r2Store("FILES") });
    const url = await t.inCtx(async ({ files }) => {
      await files.put("a.txt", "from r2", { contentType: "text/plain" });
      return files.signedUrl("a.txt");
    }, { env: { FILES: bucket } });
    expect(bucket.objects.has("a.txt")).toBe(true);
    const res = await t.req(url, {}, { FILES: bucket });
    expect(await res.text()).toBe("from r2");
  });
});
