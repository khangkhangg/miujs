/**
 * Journey 6 — Node parity: the same app started with `node --experimental-strip-types server-node.ts`
 * (node:sqlite, node:http adapter) passes a representative subset of the visitor, creator, agent and admin
 * journeys. Skips when `node` is not on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMcpClient } from "../../../src/client/index.ts";
import { ADMIN_EMAIL, ADMIN_PASSWORD, Client, creator, panorama, panorama2, squarePng, startServer, toBase64, unique, type Server } from "./helpers.ts";

const hasNode = Bun.which("node") !== null;
if (!hasNode) console.warn("[tour-studio node parity] skipped: node not found");

describe.skipIf(!hasNode)("Tour Studio on Node", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = await startServer({ runtime: "node" });
    base = server.url;
  }, 60_000);
  afterAll(() => server?.stop());

  test("serves from node", () => {
    expect(server.output()).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+ \(node v\d+/);
  });

  test("visitor: landing, bundle with ETag/304, viewer CSP, media 200/304/206/416", async () => {
    const landing = await fetch(`${base}/`);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain(`<a href="/t/demo-house">Demo house</a>`);

    const res = await fetch(`${base}/api/public/tours/demo-house`);
    const b = (await res.json()) as { scenes: { panoramaUrl: string }[]; hotspots: unknown[] };
    expect(b.scenes).toHaveLength(3);
    expect(b.hotspots).toHaveLength(5);
    expect((await fetch(`${base}/api/public/tours/demo-house`, { headers: { "if-none-match": res.headers.get("etag")! } })).status).toBe(304);

    const viewer = await fetch(`${base}/t/demo-house`);
    expect(viewer.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+' 'self'/);

    const url = base + b.scenes[0]!.panoramaUrl;
    const full = await fetch(url);
    const bytes = new Uint8Array(await full.arrayBuffer());
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe(String(bytes.length)); // Node keeps Content-Length
    expect((await fetch(url, { headers: { "if-none-match": full.headers.get("etag")! } })).status).toBe(304);
    const part = await fetch(url, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(10, 20));
    expect((await fetch(url, { headers: { range: `bytes=${bytes.length}-` } })).status).toBe(416);

    expect((await (await fetch(`${base}/openapi.json`)).json()).openapi).toStartWith("3.1");
    expect(await (await fetch(`${base}/llms.txt`)).text()).toContain("tour_create");
    expect((await fetch(`${base}/__miu`)).status).toBe(404);
  });

  test("creator: form signup, cookie flags, upload (201/422/415), hotspots, publish (422 then 200), unpublish, delete", async () => {
    const c = new Client(base);
    const me = unique("nodecreator");
    c.headers["x-forwarded-for"] = me.ip;
    const signup = await c.form("/signup", { name: "Nadia", email: me.email, password: "node-password" });
    expect(signup.status).toBe(303);
    const cookie = signup.headers.getSetCookie().find((x) => x.startsWith("miu.sid="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const tour = (await (await c.json("POST", "/api/tours", { title: "Node Loft" })).json()) as { id: string; slug: string };
    const a = await c.upload(tour.id, await panorama(), "loft.png");
    expect(a.status).toBe(201);
    const s1 = (await a.json()) as { id: string; panoramaKey: string };
    const s2 = (await (await c.upload(tour.id, await panorama2(), "bath.png")).json()) as { id: string };
    expect((await c.upload(tour.id, await squarePng(), "sq.png")).status).toBe(422);
    expect((await c.upload(tour.id, new TextEncoder().encode("text"), "x.jpg", "image/jpeg")).status).toBe(415);

    const broken = (await (await c.json("POST", `/api/scenes/${s1.id}/hotspots`, { kind: "link", yaw: 10, pitch: 0 })).json()) as { id: string };
    expect((await c.json("POST", `/api/tours/${tour.id}/publish`)).status).toBe(422);
    expect((await c.json("PATCH", `/api/hotspots/${broken.id}`, { targetSceneId: s2.id })).status).toBe(200);
    expect((await c.json("POST", `/api/scenes/${s2.id}/hotspots`, { kind: "info", yaw: 0, pitch: 0, title: "Info" })).status).toBe(201);
    expect((await c.json("POST", `/api/tours/${tour.id}/publish`)).status).toBe(200);
    expect((await fetch(`${base}/t/${tour.slug}`)).status).toBe(200);
    expect((await c.json("POST", `/api/tours/${tour.id}/unpublish`)).status).toBe(200);
    expect((await fetch(`${base}/t/${tour.slug}`)).status).toBe(404);
    expect((await c.json("DELETE", `/api/tours/${tour.id}`)).status).toBe(204);
    expect((await c.get(`/media/${s1.panoramaKey}`)).status).toBe(404);
  });

  test("security: CSRF, ownership, rate limit, logout", async () => {
    const alice = await creator(base, "Alice");
    const bob = await creator(base, "Bob");
    const t = (await (await alice.client.json("POST", "/api/tours", { title: "Alice on Node" })).json()) as { id: string };
    expect((await bob.client.json("DELETE", `/api/tours/${t.id}`)).status).toBe(403);
    const cross = await alice.client.fetch("/api/tours", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" }, body: "title=x" });
    expect(cross.status).toBe(403);

    const brute = new Client(base);
    brute.headers["x-forwarded-for"] = unique().ip;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await brute.json("POST", "/login", { email: ADMIN_EMAIL, password: `x${i}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);

    const stolen = alice.client.cookies.get("miu.sid")!;
    await alice.client.json("POST", "/logout");
    const thief = new Client(base);
    thief.cookies.set("miu.sid", stolen);
    expect((await thief.json("GET", "/api/me")).status).toBe(401);
  });

  test("agent over MCP and admin edit with audit", async () => {
    const { client } = await creator(base, "Node Agent Owner");
    const { key } = (await (await client.json("POST", "/api/keys", {})).json()) as { key: string };
    const agent = createMcpClient(`${base}/mcp`, { headers: { authorization: `Bearer ${key}` } });
    await agent.initialize();
    const tour = (await agent.callTool("tour_create", { title: "Agent on Node" })).structuredContent as { id: string; slug: string };
    const s1 = (await agent.callTool("scene_import", { id: tour.id, title: "A", panoramaBase64: toBase64(await panorama()) })).structuredContent as { id: string };
    const s2 = (await agent.callTool("scene_import", { id: tour.id, title: "B", panoramaBase64: toBase64(await panorama2()) })).structuredContent as { id: string };
    expect((await agent.callTool("hotspot_create", { id: s1.id, kind: "link", yaw: 0, pitch: 0, targetSceneId: s2.id })).isError).toBe(false);
    expect((await agent.callTool("tour_publish", { id: tour.id })).isError).toBe(false);
    expect((await fetch(`${base}/t/${tour.slug}`)).status).toBe(200);

    const admin = new Client(base);
    admin.headers["x-forwarded-for"] = unique().ip;
    expect((await admin.json("POST", "/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).status).toBe(200);
    const { token } = (await (await admin.json("GET", "/admin/api/_csrf")).json()) as { token: string };
    const upd = await admin.json("PATCH", `/admin/api/tours/${tour.id}`, { title: "Renamed on Node" }, { "x-csrf-token": token, origin: base });
    expect(upd.status).toBe(200);
    const audit = (await (await admin.json("GET", `/admin/api/audit?filter[recordId]=${tour.id}`)).json()) as { items: { changes: unknown }[] };
    expect(audit.items[0]!.changes).toEqual({ title: { from: "Agent on Node", to: "Renamed on Node" } });
  });
});
