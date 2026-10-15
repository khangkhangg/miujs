/**
 * Journey 1 — a visitor (no account): landing page, public bundle, viewer page, panorama media with
 * conditional and range requests, drafts invisible, OpenAPI and llms.txt. Real server (Bun, production mode).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, creator, startServer, type Server } from "./helpers.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  server = await startServer();
  base = server.url;
}, 60_000);
afterAll(() => server?.stop());

interface Bundle {
  tour: { id: string; title: string; slug: string; status: string; startSceneId: string; ownerId?: string };
  scenes: { id: string; title: string; panoramaUrl: string; panoramaKey: string; width: number; height: number }[];
  hotspots: { id: string; sceneId: string; kind: string; targetSceneId?: string }[];
}

describe("visitor journey", () => {
  test("landing page lists the published demo tour", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`<a href="/t/demo-house">Demo house</a>`);
    expect(html).toContain("Log in");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    // Production: no Server-Timing (it would leak internals) and no inspector.
    expect(res.headers.get("server-timing")).toBeNull();
  });

  test("public bundle: scenes, hotspots, no owner id, ETag + 304", async () => {
    const res = await fetch(`${base}/api/public/tours/demo-house`);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Bundle;
    expect(b.tour.title).toBe("Demo house");
    expect(b.tour.status).toBe("published");
    expect(b.tour.ownerId).toBeUndefined();
    expect(b.scenes.map((s) => s.title)).toEqual(["Lobby", "Kitchen", "Garden"]);
    expect(b.scenes.every((s) => s.panoramaUrl === `/media/${s.panoramaKey}`)).toBe(true);
    expect(b.tour.startSceneId).toBe(b.scenes[0]!.id);
    const links = b.hotspots.filter((h) => h.kind === "link");
    expect(links).toHaveLength(4);
    const sceneIds = new Set(b.scenes.map((s) => s.id));
    expect(links.every((h) => sceneIds.has(h.targetSceneId!))).toBe(true);

    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const again = await fetch(`${base}/api/public/tours/demo-house`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  test("viewer page: strict CSP with a nonce, embedded bundle, versioned assets", async () => {
    const res = await fetch(`${base}/t/demo-house`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+' 'self'/);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain(`<script type="application/json" id="miu-tour-data">`);
    expect(html).not.toMatch(/\son[a-z]+=/); // no inline event handlers
    const asset = /src="(\/assets\/viewer\.js\?v=[0-9a-f]+)"/.exec(html)![1]!;
    const js = await fetch(base + asset);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
  });

  test("panorama media: 200, ETag/304, Range/206, 416, HEAD, immutable caching", async () => {
    const b = (await (await fetch(`${base}/api/public/tours/demo-house`)).json()) as Bundle;
    const url = base + b.scenes[0]!.panoramaUrl;

    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/png");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await full.arrayBuffer());
    // Content-Length is not asserted here: on Bun it is dropped for disk-backed blobs (see framework-bugs.test.ts).
    expect(bytes.length).toBeGreaterThan(1000);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const etag = full.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const notModified = await fetch(url, { headers: { "if-none-match": etag } });
    expect(notModified.status).toBe(304);
    expect((await notModified.arrayBuffer()).byteLength).toBe(0);

    const partial = await fetch(url, { headers: { range: "bytes=0-99" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-99/${bytes.length}`);
    const part = new Uint8Array(await partial.arrayBuffer());
    expect(part).toEqual(bytes.subarray(0, 100));

    const tail = await fetch(url, { headers: { range: "bytes=-10" } });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(bytes.length - 10));

    const bad = await fetch(url, { headers: { range: `bytes=${bytes.length + 10}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${bytes.length}`);

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length)); // HEAD never opens the file

    expect((await fetch(`${base}/media/tours/nope/missing.png`)).status).toBe(404);
    expect((await fetch(`${base}/media/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  test("drafts are invisible: no bundle, no viewer page, no media, not on the landing page", async () => {
    const { client } = await creator(base);
    const tour = (await (await client.json("POST", "/api/tours", { title: "Secret draft villa" })).json()) as { id: string; slug: string };
    const { panorama } = await import("./helpers.ts");
    const scene = (await (await client.upload(tour.id, await panorama())).json()) as { panoramaKey: string };
    // The owner can preview it...
    expect((await client.get(`/media/${scene.panoramaKey}`)).status).toBe(200);
    expect((await client.get(`/t/${tour.slug}`)).status).toBe(200);
    // ...a visitor cannot.
    const visitor = new Client(base);
    expect((await visitor.get(`/api/public/tours/${tour.slug}`)).status).toBe(404);
    expect((await visitor.get(`/t/${tour.slug}`)).status).toBe(404);
    expect((await visitor.get(`/media/${scene.panoramaKey}`)).status).toBe(404);
    expect(await (await visitor.get("/")).text()).not.toContain("Secret draft villa");
    const list = (await (await visitor.get("/api/tours/published")).json()) as { items: { slug: string }[] };
    expect(list.items.map((t) => t.slug)).toEqual(["demo-house"]);
  });

  test("creator API is closed to visitors", async () => {
    const res = await fetch(`${base}/api/tours`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const page = await fetch(`${base}/editor`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2Feditor");
  });

  test("/openapi.json is a sane OpenAPI 3.1 document", async () => {
    const res = await fetch(`${base}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; info: { title: string; version: string }; paths: Record<string, Record<string, { operationId?: string }>> };
    expect(doc.openapi).toStartWith("3.1");
    expect(doc.info.title).toBe("tour-studio");
    expect(doc.paths["/api/tours"]?.post?.operationId).toBe("tour_create");
    expect(doc.paths["/api/tours/{id}/publish"]?.post?.operationId).toBe("tour_publish");
    expect(doc.paths["/api/public/tours/{slug}"]?.get).toBeDefined();
    expect(doc.paths["/api/me"]?.get?.operationId).toBe("whoami");
    expect(doc.paths["/admin/api/tours"]?.get).toBeDefined();
    // hidden routes stay out
    expect(doc.paths["/media/{path}"] ?? doc.paths["/media/*"]).toBeUndefined();
    expect(doc.paths["/login"]).toBeUndefined();
  });

  test("/llms.txt lists the agent tools and the MCP endpoint", async () => {
    const res = await fetch(`${base}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const txt = await res.text();
    expect(txt).toStartWith("# tour-studio");
    expect(txt).toContain("tour_create");
    expect(txt).toContain("scene_import");
    expect(txt).toContain(`${base}/mcp`);
    expect(txt).not.toContain("/login");
    const full = await fetch(`${base}/llms-full.txt`);
    expect(full.status).toBe(200);
    expect(await full.text()).toContain("panoramaBase64");
  });

  test("unknown pages: HTML 404 for browsers, problem+json for APIs", async () => {
    const html = await fetch(`${base}/nope`, { headers: { accept: "text/html" } });
    expect(html.status).toBe(404);
    expect(await html.text()).toContain("Not found");
    const api = await fetch(`${base}/api/nope`);
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/problem+json");
  });
});
