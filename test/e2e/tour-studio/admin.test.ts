/**
 * Journey 5 — the seeded admin: back-office API (users, tours, scenes, audit log), an edit recorded in the
 * audit log, read-only resources, cascade delete, and admin tools over MCP. Real server (Bun, production).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createMcpClient } from "../../../src/client/index.ts";
import { ADMIN_EMAIL, ADMIN_PASSWORD, Client, creator, panorama, startServer, unique, type Server } from "./helpers.ts";

let server: Server;
let base = "";
beforeAll(async () => {
  server = await startServer();
  base = server.url;
}, 60_000);
afterAll(() => server?.stop());

describe("admin journey", () => {
  const admin = new Client("");
  let token = "";
  /** Admin write: same-origin with the synchronizer token. */
  const write = (method: string, path: string, body?: unknown) => admin.json(method, path, body, { "x-csrf-token": token, origin: base });

  test("the seeded admin logs in with the form and opens /admin", async () => {
    (admin as { base: string }).base = base;
    admin.headers["x-forwarded-for"] = unique("adm").ip;
    const res = await admin.form("/login?next=/admin", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    const page = await admin.get("/admin", { accept: "text/html" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Tour Studio Admin");
    expect(await (await admin.get("/")).text()).toContain(`href="/admin"`);
    token = ((await (await admin.json("GET", "/admin/api/_csrf")).json()) as { token: string }).token;
    expect(token.length).toBeGreaterThan(20);
  });

  test("_meta describes users, tours, scenes and a read-only audit log", async () => {
    const meta = (await (await admin.json("GET", "/admin/api/_meta")).json()) as { resources: { name: string; permissions: Record<string, boolean>; fields: Record<string, unknown> }[] };
    const byName = Object.fromEntries(meta.resources.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(["audit", "scenes", "tours", "users"]);
    expect(byName.audit!.permissions).toEqual({ list: true, read: true, create: false, update: false, delete: false });
    expect(byName.users!.permissions.delete).toBe(false);
    expect(byName.users!.fields.passwordHash).toBeUndefined();
    expect(byName.tours!.fields.ownerId).toMatchObject({ widget: "relation", relation: { resource: "users", labelField: "email" } });
  });

  test("lists users (no password hashes) and tours", async () => {
    await creator(base, "Listed Creator");
    const users = (await (await admin.json("GET", "/admin/api/users?limit=100")).json()) as { items: Record<string, unknown>[]; total: number };
    expect(users.items.map((u) => u.email)).toEqual(expect.arrayContaining([ADMIN_EMAIL, "demo@example.com"]));
    expect(users.items.some((u) => u.name === "Listed Creator")).toBe(true);
    expect(users.items.every((u) => !("passwordHash" in u))).toBe(true);
    const search = (await (await admin.json("GET", "/admin/api/users?q=listed")).json()) as { total: number };
    expect(search.total).toBe(1);
    const tours = (await (await admin.json("GET", `/admin/api/tours?filter=${encodeURIComponent(JSON.stringify({ status: "published" }))}`)).json()) as { items: { slug: string }[] };
    expect(tours.items.map((t) => t.slug)).toContain("demo-house");
  });

  test("edits a tour title: visible publicly, recorded in the audit log", async () => {
    const tours = (await (await admin.json("GET", "/admin/api/tours?filter[slug]=demo-house")).json()) as { items: { id: string; title: string }[] };
    const demo = tours.items[0]!;
    const before = await fetch(`${base}/api/public/tours/demo-house`);
    const etag = before.headers.get("etag")!;

    const res = await write("PATCH", `/admin/api/tours/${demo.id}`, { title: "Demo house (renovated)" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("Demo house (renovated)");
    // read-only fields cannot be changed through the admin (unknown/read-only keys are stripped, not rejected)
    const ro = await write("PATCH", `/admin/api/tours/${demo.id}`, { startSceneId: "nope" });
    expect(ro.status).toBe(200);
    expect(((await ro.json()) as { startSceneId: string }).startSceneId).not.toBe("nope");

    const pub = await fetch(`${base}/api/public/tours/demo-house`, { headers: { "if-none-match": etag } });
    expect(pub.status).toBe(200); // content changed: new ETag
    expect(((await pub.json()) as { tour: { title: string } }).tour.title).toBe("Demo house (renovated)");

    const audit = (await (await admin.json("GET", `/admin/api/audit?filter[recordId]=${demo.id}`)).json()) as { items: { action: string; resource: string; user: string; changes: unknown }[] };
    // Two updates: the title change, and the stripped read-only patch above (audited with empty changes).
    expect(audit.items.map((a) => a.action)).toEqual(["update", "update"]);
    const titleChange = audit.items.find((a) => (a.changes as Record<string, unknown>).title)!;
    const me = (await (await admin.json("GET", "/api/me")).json()) as { id: string };
    expect(titleChange).toMatchObject({ action: "update", resource: "tours", user: me.id, changes: { title: { from: demo.title, to: "Demo house (renovated)" } } });
  });

  test("the audit log is read-only and users cannot be deleted", async () => {
    const audit = (await (await admin.json("GET", "/admin/api/audit")).json()) as { items: { id: string }[] };
    expect((await write("POST", "/admin/api/audit", { at: "x", user: "x", action: "create", resource: "x", recordId: "x" })).status).toBe(403);
    expect((await write("DELETE", `/admin/api/audit/${audit.items[0]!.id}`)).status).toBe(403);
    const users = (await (await admin.json("GET", "/admin/api/users")).json()) as { items: { id: string }[] };
    expect((await write("DELETE", `/admin/api/users/${users.items[0]!.id}`)).status).toBe(403);
  });

  test("deleting a tour in the admin also removes its scenes, hotspots and panoramas", async () => {
    const { client } = await creator(base, "Doomed");
    const tour = (await (await client.json("POST", "/api/tours", { title: "Doomed tour" })).json()) as { id: string };
    const scene = (await (await client.upload(tour.id, await panorama())).json()) as { id: string };
    await client.json("POST", `/api/scenes/${scene.id}/hotspots`, { kind: "info", yaw: 0, pitch: 0, title: "hi" });
    const metaDir = join(server.dataDir, "panoramas", "meta", "tours", tour.id);
    expect(readdirSync(metaDir)).toHaveLength(1);

    expect((await write("DELETE", `/admin/api/tours/${tour.id}`)).status).toBe(204);
    expect((await client.json("GET", `/api/tours/${tour.id}`)).status).toBe(404);
    const scenes = (await (await admin.json("GET", `/admin/api/scenes?filter[tourId]=${tour.id}`)).json()) as { total: number };
    expect(scenes.total).toBe(0);
    expect(existsSync(metaDir) ? readdirSync(metaDir) : []).toEqual([]);
    const audit = (await (await admin.json("GET", `/admin/api/audit?filter[recordId]=${tour.id}`)).json()) as { items: { action: string }[] };
    expect(audit.items.map((a) => a.action)).toEqual(["delete"]);
  });

  test("admin tools over MCP with the admin's API key", async () => {
    const key = (await (await admin.json("POST", "/api/keys", { name: "ops-bot" })).json()) as { key: string };
    const agent = createMcpClient(`${base}/mcp`, { headers: { authorization: `Bearer ${key.key}` } });
    const names = (await agent.listTools()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["admin_meta", "admin_list_users", "admin_update_tours", "admin_list_audit"]));
    const r = await agent.callTool("admin_list_tours", { q: "renovated" });
    expect(r.isError).toBe(false);
    expect((r.structuredContent as { total: number }).total).toBe(1);
    // bearer writes need no CSRF token (browsers cannot attach Authorization cross-site)
    const id = (r.structuredContent as { items: { id: string }[] }).items[0]!.id;
    const upd = await agent.callTool("admin_update_tours", { id, description: "Updated by the ops bot" });
    expect(upd.isError).toBe(false);
  });
});
