/**
 * Journey 2 — a creator: sign up, log in, build a tour (uploads + hotspots), publish, unpublish, delete.
 * Real server (Bun, production mode), HTTP only; storage is checked through the server's own data dir only
 * where HTTP cannot see it (panorama files gone after delete).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client, panorama, panorama2, squarePng, startServer, unique, type Server } from "./helpers.ts";

let server: Server;
let base = "";
beforeAll(async () => {
  server = await startServer();
  base = server.url;
}, 60_000);
afterAll(() => server?.stop());

/** Every panorama blob currently stored for a tour (sidecars mirror keys under meta/). */
function storedBlobs(tourId: string): string[] {
  const dir = join(server.dataDir, "panoramas", "meta", "tours", tourId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("creator journey", () => {
  const me = unique("casey");
  const password = "sup3r secret pass";
  const c = new Client("");
  let tourId = "";
  let slug = "";
  let s1: { id: string; panoramaKey: string; width: number; height: number; title: string };
  let s2: { id: string; panoramaKey: string };

  beforeAll(() => {
    (c as { base: string }).base = base;
    c.headers["x-forwarded-for"] = me.ip;
  });

  test("sign up with the HTML form: redirected to the editor with a session", async () => {
    const page = await c.get("/signup", { accept: "text/html" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`<form class="auth" method="post" action="/signup">`);

    const short = await c.form("/signup", { name: "Casey", email: me.email, password: "short" });
    expect(short.status).toBe(422);
    expect(await short.text()).toContain("Please check the form");

    const res = await c.form("/signup", { name: "Casey", email: me.email, password });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/editor");
    expect(c.cookies.has("miu.sid")).toBe(true);
    const who = await c.json("GET", "/api/me");
    expect(await who.json()).toMatchObject({ email: me.email, name: "Casey", roles: ["creator"] });

    const dup = await c.json("POST", "/signup", { name: "Casey 2", email: me.email.toUpperCase(), password });
    expect(dup.status).toBe(409);
  });

  test("log out, then log in: HttpOnly SameSite cookie, new session id", async () => {
    const before = c.cookies.get("miu.sid");
    const out = await c.form("/logout", {});
    expect(out.status).toBe(303);
    expect(c.cookies.has("miu.sid")).toBe(false);
    expect((await c.json("GET", "/api/me")).status).toBe(401);

    const wrong = await c.form("/login?next=/editor", { email: me.email, password: "nope nope" });
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get("location")).toBe("/login?error=1&next=%2Feditor");

    const res = await c.form("/login?next=/editor", { email: me.email, password });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/editor");
    const cookie = res.headers.getSetCookie().find((x) => x.startsWith("miu.sid="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(c.cookies.get("miu.sid")).not.toBe(before);

    // open redirects are refused
    const evil = await c.form("/login?next=//evil.example", { email: me.email, password });
    expect(evil.headers.get("location")).toBe("/editor");

    const editor = await c.get("/editor", { accept: "text/html" });
    expect(editor.status).toBe(200);
    expect(await editor.text()).toContain("miu-editor-app");
  });

  test("create a tour", async () => {
    const res = await c.json("POST", "/api/tours", { title: "Seaside Villa", description: "Two rooms by the sea" });
    expect(res.status).toBe(201);
    const tour = (await res.json()) as { id: string; slug: string; status: string };
    expect(tour.status).toBe("draft");
    expect(tour.slug).toBe("seaside-villa");
    tourId = tour.id;
    slug = tour.slug;
    const list = (await (await c.json("GET", "/api/tours")).json()) as { items: { id: string }[]; total: number };
    expect(list.items.map((t) => t.id)).toEqual([tourId]);
  });

  test("upload panoramas: two valid PNGs, a non-2:1 image (422), a text file named .jpg (415)", async () => {
    const r1 = await c.upload(tourId, await panorama(), "living_room.png");
    expect(r1.status).toBe(201);
    s1 = await r1.json();
    expect(s1).toMatchObject({ width: 1024, height: 512, title: "living room" });
    expect(s1.panoramaKey).toMatch(new RegExp(`^tours/${tourId}/[A-Za-z0-9_-]+\\.png$`));

    const r2 = await c.upload(tourId, await panorama2(), "kitchen.png", "image/png", "Kitchen");
    expect(r2.status).toBe(201);
    s2 = await r2.json();

    const square = await c.upload(tourId, await squarePng(), "square.png");
    expect(square.status).toBe(422);
    const p422 = await square.json();
    expect(p422.code).toBe("file_invalid");
    expect(p422.detail).toContain("equirectangular");

    const fake = await c.upload(tourId, new TextEncoder().encode("hello, I am not a JPEG"), "photo.jpg", "image/jpeg");
    expect(fake.status).toBe(415);
    expect((await fake.json()).code).toBe("file_type_mismatch");

    const untyped = await c.upload(tourId, new TextEncoder().encode("plain text"), "photo.jpg", "");
    expect(untyped.status).toBe(415);

    // Only the two valid panoramas were stored; the first became the start scene.
    expect(storedBlobs(tourId)).toHaveLength(2);
    const full = (await (await c.json("GET", `/api/tours/${tourId}`)).json()) as { tour: { startSceneId: string }; scenes: { id: string }[] };
    expect(full.scenes.map((s) => s.id)).toEqual([s1.id, s2.id]);
    expect(full.tour.startSceneId).toBe(s1.id);
    // The owner can load their draft media.
    expect((await c.get(`/media/${s1.panoramaKey}`)).status).toBe(200);
  });

  let brokenId = "";
  test("hotspots: link + info; publishing a broken graph fails with problems, then succeeds", async () => {
    const link = await c.json("POST", `/api/scenes/${s1.id}/hotspots`, { kind: "link", yaw: 45, pitch: -5, targetSceneId: s2.id, title: "To the kitchen" });
    expect(link.status).toBe(201);
    const info = await c.json("POST", `/api/scenes/${s1.id}/hotspots`, { kind: "info", yaw: -30, pitch: 10, title: "Sea view", text: "Best at sunset", url: "https://example.com/sea" });
    expect(info.status).toBe(201);
    const selfLink = await c.json("POST", `/api/scenes/${s2.id}/hotspots`, { kind: "link", yaw: 0, pitch: 0, targetSceneId: s2.id });
    expect(selfLink.status).toBe(422);
    const broken = await c.json("POST", `/api/scenes/${s2.id}/hotspots`, { kind: "link", yaw: 170, pitch: 0, title: "Nowhere" });
    expect(broken.status).toBe(201);
    brokenId = ((await broken.json()) as { id: string }).id;

    const fail = await c.json("POST", `/api/tours/${tourId}/publish`);
    expect(fail.status).toBe(422);
    const p = (await fail.json()) as { code: string; problems: { code: string; hotspotId: string }[] };
    expect(p.code).toBe("tour_invalid");
    expect(p.problems).toEqual([expect.objectContaining({ code: "link_missing_target", hotspotId: brokenId })]);

    const fix = await c.json("PATCH", `/api/hotspots/${brokenId}`, { targetSceneId: s1.id, title: "Back to the living room" });
    expect(fix.status).toBe(200);
    const ok = await c.json("POST", `/api/tours/${tourId}/publish`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("published");
  });

  test("published: visible to visitors on the landing page, bundle and viewer", async () => {
    const visitor = new Client(base);
    expect(await (await visitor.get("/")).text()).toContain(`<a href="/t/${slug}">Seaside Villa</a>`);
    const bundle = await visitor.get(`/api/public/tours/${slug}`);
    expect(bundle.status).toBe(200);
    const b = (await bundle.json()) as { scenes: unknown[]; hotspots: unknown[] };
    expect(b.scenes).toHaveLength(2);
    expect(b.hotspots).toHaveLength(3);
    expect((await visitor.get(`/t/${slug}`)).status).toBe(200);
    expect((await visitor.get(`/media/${s1.panoramaKey}`)).status).toBe(200);
  });

  test("unpublish hides it again", async () => {
    const res = await c.json("POST", `/api/tours/${tourId}/unpublish`);
    expect(((await res.json()) as { status: string }).status).toBe("draft");
    const visitor = new Client(base);
    expect((await visitor.get(`/api/public/tours/${slug}`)).status).toBe(404);
    expect((await visitor.get(`/t/${slug}`)).status).toBe(404);
    expect((await visitor.get(`/media/${s1.panoramaKey}`)).status).toBe(404);
    expect(await (await visitor.get("/")).text()).not.toContain("Seaside Villa");
  });

  test("delete the tour: API 404s and its panoramas are gone from storage", async () => {
    expect(storedBlobs(tourId)).toHaveLength(2);
    const del = await c.json("DELETE", `/api/tours/${tourId}`);
    expect(del.status).toBe(204);
    expect((await c.json("GET", `/api/tours/${tourId}`)).status).toBe(404);
    expect((await c.get(`/media/${s1.panoramaKey}`)).status).toBe(404);
    expect((await c.json("GET", `/api/scenes/${s1.id}/hotspots`)).status).toBe(405); // route exists for POST only
    expect(storedBlobs(tourId)).toEqual([]);
    const data = readdirSync(join(server.dataDir, "panoramas", "data"));
    // Only the 3 demo panoramas remain on disk.
    expect(data).toHaveLength(3);
  });
});
