import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miu, route } from "miujs";
import { mimeType, staticFiles, type StaticOptions } from "../src/index.ts";
import { nodeFileSource } from "../src/fs.ts";

let root: string;
let dir: string;
const JS = "console.log('app');\n".repeat(20);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "miu-web-"));
  dir = join(root, "public");
  await mkdir(join(dir, "assets"), { recursive: true });
  await mkdir(join(dir, "docs"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(root, "secret.txt"), "TOP SECRET");
  await writeFile(join(dir, "index.html"), "<h1>home</h1>");
  await writeFile(join(dir, "docs", "index.html"), "<h1>docs</h1>");
  await writeFile(join(dir, "app.js"), JS);
  await writeFile(join(dir, "app.js.br"), "BROTLI");
  await writeFile(join(dir, "app.js.gz"), "GZIPPED");
  await writeFile(join(dir, "style.css"), "body{}");
  await writeFile(join(dir, "assets", "main-BxY12abc.js"), "hashed");
  await writeFile(join(dir, "assets", "house-a1b2c3d4e5.glb"), new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4, 5, 6]));
  await writeFile(join(dir, "video.mp4"), new Uint8Array(Array.from({ length: 100 }, (_, i) => i)));
  await writeFile(join(dir, ".env"), "SECRET=1");
  await writeFile(join(dir, ".git", "config"), "[core]");
  await utimes(join(dir, "app.js"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const hello = route.get("/api/hello", { handler: () => ({ hi: true }) });

function appWith(opts: Partial<StaticOptions> = {}) {
  return miu({ routes: [hello], plugins: [staticFiles({ dir, ...opts })], logLevel: "silent" });
}

function get(app: ReturnType<typeof miu>, path: string, headers: Record<string, string> = {}, method = "GET") {
  return app.request(path, { method, headers });
}

describe("mimeType", () => {
  test("knows web, 3D and media types", () => {
    const cases: Record<string, string> = {
      "a.js": "text/javascript; charset=utf-8",
      "a.mjs": "text/javascript; charset=utf-8",
      "a.css": "text/css; charset=utf-8",
      "a.html": "text/html; charset=utf-8",
      "a.htm": "text/html; charset=utf-8",
      "a.json": "application/json; charset=utf-8",
      "a.map": "application/json; charset=utf-8",
      "a.webmanifest": "application/manifest+json",
      "a.txt": "text/plain; charset=utf-8",
      "a.xml": "application/xml; charset=utf-8",
      "a.svg": "image/svg+xml",
      "a.wasm": "application/wasm",
      "a.glb": "model/gltf-binary",
      "a.gltf": "model/gltf+json",
      "a.bin": "application/octet-stream",
      "a.ktx2": "image/ktx2",
      "a.basis": "application/octet-stream",
      "a.hdr": "image/vnd.radiance",
      "a.exr": "image/x-exr",
      "a.usdz": "model/vnd.usdz+zip",
      "a.obj": "model/obj",
      "a.stl": "model/stl",
      "a.drc": "application/octet-stream",
      "a.png": "image/png",
      "a.jpg": "image/jpeg",
      "a.jpeg": "image/jpeg",
      "a.gif": "image/gif",
      "a.webp": "image/webp",
      "a.avif": "image/avif",
      "a.ico": "image/x-icon",
      "a.mp4": "video/mp4",
      "a.webm": "video/webm",
      "a.mp3": "audio/mpeg",
      "a.ogg": "audio/ogg",
      "a.wav": "audio/wav",
      "a.m4a": "audio/mp4",
      "a.m3u8": "application/vnd.apple.mpegurl",
      "a.ts": "video/mp2t",
      "a.woff": "font/woff",
      "a.woff2": "font/woff2",
      "a.ttf": "font/ttf",
      "a.otf": "font/otf",
      "a.pdf": "application/pdf",
      "a.zip": "application/zip",
      "A.PNG": "image/png",
      "noext": "application/octet-stream",
      "a.unknown": "application/octet-stream",
    };
    for (const [file, type] of Object.entries(cases)) expect([file, mimeType(file)]).toEqual([file, type]);
  });
});

describe("staticFiles: serving", () => {
  test("serves a file with its MIME type, length and validators", async () => {
    const res = await get(appWith(), "/style.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("content-length")).toBe("6");
    expect(res.headers.get("etag")).toMatch(/^"[^"]+"$/);
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("body{}");
  });

  test("routes win over files; non-GET methods are not served", async () => {
    const app = appWith();
    expect(await (await get(app, "/api/hello")).json()).toEqual({ hi: true });
    const post = await get(app, "/style.css", {}, "POST");
    expect(post.status).toBe(404);
  });

  test("HEAD returns headers without a body", async () => {
    const res = await get(appWith(), "/style.css", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("6");
    expect(await res.text()).toBe("");
  });

  test("missing files fall through to the app's 404", async () => {
    const res = await get(appWith(), "/nope.js");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("MIU_E_ROUTE_NOT_FOUND");
  });

  test("directories serve their index; a directory without trailing slash redirects", async () => {
    const app = appWith();
    expect(await (await get(app, "/")).text()).toBe("<h1>home</h1>");
    expect(await (await get(app, "/docs/")).text()).toBe("<h1>docs</h1>");
    const r = await get(app, "/docs?x=1");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/docs/?x=1");
  });

  test("a custom index name", async () => {
    const res = await get(appWith({ index: "app.js" }), "/");
    expect(await res.text()).toBe(JS);
  });

  test("prefix mounts the directory under a path", async () => {
    const app = appWith({ prefix: "/static" });
    expect(await (await get(app, "/static/style.css")).text()).toBe("body{}");
    expect((await get(app, "/style.css")).status).toBe(404);
    expect((await get(app, "/staticstyle.css")).status).toBe(404);
    const trailing = appWith({ prefix: "/static/" });
    expect(await (await get(trailing, "/static/style.css")).text()).toBe("body{}");
  });

  test("binary 3D assets keep their bytes", async () => {
    const res = await get(appWith(), "/assets/house-a1b2c3d4e5.glb");
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4, 5, 6]));
  });

  test("decodes percent-encoded names", async () => {
    await writeFile(join(dir, "my file.txt"), "spaced");
    expect(await (await get(appWith(), "/my%20file.txt")).text()).toBe("spaced");
  });
});

describe("staticFiles: caching", () => {
  test("hashed asset names are immutable for a year", async () => {
    const res = await get(appWith(), "/assets/main-BxY12abc.js");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("HTML is no-cache; other unhashed files revalidate", async () => {
    const app = appWith();
    expect((await get(app, "/")).headers.get("cache-control")).toBe("no-cache");
    expect((await get(app, "/style.css")).headers.get("cache-control")).toBe("no-cache");
  });

  test("custom immutable pattern", async () => {
    const res = await get(appWith({ immutable: /\.css$/ }), "/style.css");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("If-None-Match with the current ETag returns 304", async () => {
    const app = appWith();
    const etag = (await get(app, "/style.css")).headers.get("etag")!;
    for (const inm of [etag, `"other", ${etag}`, `W/${etag}`, "*"]) {
      const res = await get(app, "/style.css", { "if-none-match": inm });
      expect([inm, res.status]).toEqual([inm, 304]);
      expect(res.headers.get("etag")).toBe(etag);
      expect(await res.text()).toBe("");
    }
    expect((await get(app, "/style.css", { "if-none-match": '"stale"' })).status).toBe(200);
  });

  test("If-Modified-Since returns 304 when ETag is absent from the request", async () => {
    const app = appWith();
    const lm = (await get(app, "/app.js")).headers.get("last-modified")!;
    expect((await get(app, "/app.js", { "if-modified-since": lm })).status).toBe(304);
    expect((await get(app, "/app.js", { "if-modified-since": "Wed, 01 Jan 2020 00:00:00 GMT" })).status).toBe(200);
  });
});

describe("staticFiles: ranges", () => {
  test("bytes=a-b returns 206 with Content-Range", async () => {
    const res = await get(appWith(), "/video.mp4", { range: "bytes=10-19" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("content-length")).toBe("10");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test("open-ended and suffix ranges", async () => {
    const app = appWith();
    const open = await get(app, "/video.mp4", { range: "bytes=95-" });
    expect(open.headers.get("content-range")).toBe("bytes 95-99/100");
    expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([95, 96, 97, 98, 99]);
    const suffix = await get(app, "/video.mp4", { range: "bytes=-3" });
    expect(suffix.headers.get("content-range")).toBe("bytes 97-99/100");
    const clamp = await get(app, "/video.mp4", { range: "bytes=98-500" });
    expect(clamp.headers.get("content-range")).toBe("bytes 98-99/100");
  });

  test("unsatisfiable ranges return 416", async () => {
    const app = appWith();
    for (const range of ["bytes=100-", "bytes=-0"]) {
      const res = await get(app, "/video.mp4", { range });
      expect([range, res.status]).toEqual([range, 416]);
      expect(res.headers.get("content-range")).toBe("bytes */100");
    }
  });

  test("malformed or multi-range headers are ignored (full 200)", async () => {
    const app = appWith();
    for (const range of ["bytes=0-1,5-6", "items=0-1", "bytes=x-y", "bytes=50-10", "bytes=-"]) {
      const res = await get(app, "/video.mp4", { range });
      expect([range, res.status]).toEqual([range, 200]);
    }
  });

  test("If-Range with a stale ETag serves the full file", async () => {
    const res = await get(appWith(), "/video.mp4", { range: "bytes=0-1", "if-range": '"stale"' });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("100");
  });
});

describe("staticFiles: precompressed", () => {
  test("serves .br when accepted, else .gz, with Vary", async () => {
    const app = appWith();
    const br = await get(app, "/app.js", { "accept-encoding": "gzip, deflate, br" });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(br.headers.get("content-length")).toBe("6");
    expect(await br.text()).toBe("BROTLI");
    const gz = await get(app, "/app.js", { "accept-encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(await gz.text()).toBe("GZIPPED");
    expect(gz.headers.get("etag")).not.toBe(br.headers.get("etag"));
  });

  test("q=0 refuses an encoding; identity when nothing is accepted", async () => {
    const app = appWith();
    const res = await get(app, "/app.js", { "accept-encoding": "br;q=0, gzip;q=0.5" });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const none = await get(app, "/app.js");
    expect(none.headers.get("content-encoding")).toBeNull();
    expect(none.headers.get("vary")).toBe("Accept-Encoding");
    expect(await none.text()).toBe(JS);
  });

  test("ranges are served from the identity file", async () => {
    const res = await get(appWith(), "/app.js", { "accept-encoding": "br", range: "bytes=0-6" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("console");
  });

  test("precompressed: false ignores siblings", async () => {
    const res = await get(appWith({ precompressed: false }), "/app.js", { "accept-encoding": "br" });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });
});

describe("staticFiles: SPA fallback", () => {
  test("unknown paths serve the SPA file to requests that accept HTML", async () => {
    const app = appWith({ spa: "index.html" });
    const res = await get(app, "/tours/42", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("<h1>home</h1>");
  });

  test("API-style and asset requests still 404", async () => {
    const app = appWith({ spa: "index.html" });
    expect((await get(app, "/tours/42", { accept: "application/json" })).status).toBe(404);
    expect((await get(app, "/assets/missing.js", { accept: "*/*" })).status).toBe(404);
    expect((await get(app, "/tours/42")).status).toBe(404);
    expect((await get(app, "/tours/42", { accept: "text/html" }, "POST")).status).toBe(404);
  });
});

describe("staticFiles: path safety", () => {
  const evil = [
    "/..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt",
    "/%2E%2E%2Fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/..%5csecret.txt",
    "/%5c..%5csecret.txt",
    "/app.js%00.png",
    "/C:%2fWindows%2fwin.ini",
    "/C:/Windows/win.ini",
  ];
  for (const p of evil) {
    test(`refuses ${p}`, async () => {
      const app = appWith();
      // Build the request with a raw path so the URL parser cannot normalize it away first.
      const res = await app.request(new Request("http://localhost" + p));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("MIU_E_WEB_BAD_PATH");
      expect(body.error.fix).toBeTruthy();
    });
  }

  test("dot-dot segments the URL parser normalizes never escape the directory", async () => {
    const app = appWith();
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/%252e%252e%252fsecret.txt"]) {
      const res = await app.request(new Request("http://localhost" + p));
      expect(await res.text()).not.toContain("TOP SECRET");
    }
  });

  test("dotfiles and dot-directories are not served", async () => {
    const app = appWith();
    expect((await get(app, "/.env")).status).toBe(404);
    expect((await get(app, "/.git/config")).status).toBe(404);
  });

  test("malformed percent-encoding is a 400", async () => {
    const res = await appWith().request(new Request("http://localhost/%E0%A4%A"));
    expect(res.status).toBe(400);
  });
});

describe("staticFiles: Workers Static Assets", () => {
  function fakeAssets(files: Record<string, string>) {
    const seen: string[] = [];
    return {
      seen,
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        seen.push(`${req.method} ${path}`);
        const body = files[path];
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { headers: { "content-type": "text/plain" } });
      },
    };
  }

  test("delegates unmatched GETs to env.ASSETS with the prefix stripped", async () => {
    const assets = fakeAssets({ "/app.js": "from-assets" });
    const app = miu({ routes: [hello], plugins: [staticFiles({ dir, prefix: "/static" })], logLevel: "silent" });
    const res = await app.dispatch(new Request("http://x/static/app.js?v=1"), { ASSETS: assets }, { runtime: "workerd" });
    expect(await res.text()).toBe("from-assets");
    expect(assets.seen).toEqual(["GET /app.js"]);
  });

  test("an ASSETS 404 falls through to the app; routes and POSTs never hit ASSETS", async () => {
    const assets = fakeAssets({});
    const app = miu({ routes: [hello], plugins: [staticFiles({ dir })], logLevel: "silent" });
    const miss = await app.dispatch(new Request("http://x/nope.js"), { ASSETS: assets }, { runtime: "workerd" });
    expect((await miss.json()).error.code).toBe("MIU_E_ROUTE_NOT_FOUND");
    await app.dispatch(new Request("http://x/api/hello"), { ASSETS: assets }, { runtime: "workerd" });
    await app.dispatch(new Request("http://x/a.js", { method: "POST" }), { ASSETS: assets }, { runtime: "workerd" });
    expect(assets.seen).toEqual(["GET /nope.js"]);
  });

  test("without the binding on Workers, requests fall through (no filesystem)", async () => {
    const app = miu({ plugins: [staticFiles({ dir })], logLevel: "silent" });
    const res = await app.dispatch(new Request("http://x/style.css"), {}, { runtime: "workerd" });
    expect(res.status).toBe(404);
  });
});

describe("staticFiles: Node/Deno file source", () => {
  test("serves files, ranges and precompressed siblings through node:fs streams", async () => {
    const app = appWith({ source: nodeFileSource() });
    expect(await (await get(app, "/style.css")).text()).toBe("body{}");
    const part = await get(app, "/video.mp4", { range: "bytes=1-3" });
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(await (await get(app, "/app.js", { "accept-encoding": "br" })).text()).toBe("BROTLI");
    expect((await get(app, "/nope")).status).toBe(404);
  });
});

describe("staticFiles: config", () => {
  test("inspect describes the plugin", () => {
    const p = staticFiles({ dir: "dist", prefix: "/s", spa: "index.html" });
    expect(p.name).toBe("static-files");
    expect(p.inspect()).toEqual({
      dir: "dist",
      prefix: "/s",
      index: "index.html",
      spa: "index.html",
      immutable: "-[A-Za-z0-9_-]{8,}\\.",
      precompressed: true,
      workers: "delegates to env.ASSETS (Workers Static Assets) when bound",
    });
  });

  test("dir is required", () => {
    let err: any;
    try {
      staticFiles({} as any);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("MIU_E_WEB_CONFIG");
    expect(err.fix).toBeTruthy();
  });
});
