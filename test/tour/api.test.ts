import { describe, expect, test } from "bun:test";
import { listTools } from "../../src/ai/mcp.ts";
import { generateOpenAPI } from "../../src/ai/openapi.ts";
import { fakePng, samplePano, setup } from "./helpers.ts";
import type { Hotspot, Scene, Tour } from "../../src/tour/schema.ts";

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

describe("creator API: auth and ownership", () => {
  test("requires authentication", async () => {
    const { as } = setup();
    const res = await as().get("/api/tours");
    expect(res.status).toBe(401);
    expect((await as().post("/api/tours", { title: "x" })).status).toBe(401);
  });

  test("creates tours with unique slugs and lists only the caller's tours", async () => {
    const { as } = setup();
    const res = await as("alice").post("/api/tours", { title: "Ocean Villa" });
    expect(res.status).toBe(201);
    const tour = (await res.json()) as Tour;
    expect(tour).toMatchObject({ ownerId: "alice", slug: "ocean-villa", status: "draft", title: "Ocean Villa" });
    // a second tour with the same title gets a fresh slug; an explicit duplicate slug is a 409
    const second = (await (await as("alice").post("/api/tours", { title: "Ocean Villa" })).json()) as Tour;
    expect(second.slug).not.toBe("ocean-villa");
    expect(second.slug).toMatch(/^ocean-villa-/);
    expect((await as("bob").post("/api/tours", { title: "Mine", slug: "ocean-villa" })).status).toBe(409);
    await as("bob").post("/api/tours", { title: "Bob's" });

    const mine = (await (await as("alice").get("/api/tours")).json()) as { items: Tour[]; total: number };
    expect(mine.total).toBe(2);
    expect(mine.items.every((t) => t.ownerId === "alice")).toBe(true);
    const all = (await (await as("root").get("/api/tours")).json()) as { total: number };
    expect(all.total).toBe(3);
  });

  test("other users get 403; admins may manage any tour", async () => {
    const { as, seed } = setup();
    const { tour, scenes } = await seed("alice", 1);
    expect((await as("bob").get(`/api/tours/${tour.id}`)).status).toBe(403);
    expect((await as("bob").patch(`/api/tours/${tour.id}`, { title: "Hacked" })).status).toBe(403);
    expect((await as("bob").del(`/api/tours/${tour.id}`)).status).toBe(403);
    expect((await as("bob").patch(`/api/scenes/${scenes[0]!.id}`, { title: "x" })).status).toBe(403);
    expect((await as("bob").upload(tour.id, await samplePano())).status).toBe(403);
    expect((await as("root").patch(`/api/tours/${tour.id}`, { title: "Admin edit" })).status).toBe(200);
    expect((await as("alice").get("/api/tours/nope")).status).toBe(404);
  });

  test("cookie-authenticated writes need a CSRF-safe request", async () => {
    const { app, seed } = setup();
    const { tour } = await seed("alice", 0);
    // A cross-site form post: cookie credentials, simple content-type, no custom header.
    const forged = await app.request(`/api/tours/${tour.id}/publish`, {
      method: "POST",
      headers: { "x-test-user": "alice", cookie: "miu.sid=abc", "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { code: string }).code).toBe("csrf");
    const crossSite = await app.request(`/api/tours/${tour.id}`, {
      method: "PATCH",
      headers: { "x-test-user": "alice", cookie: "miu.sid=abc", "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(crossSite.status).toBe(403);
    // JSON from the same origin is fine (a cross-site page cannot send it without a CORS preflight).
    const ok = await app.request(`/api/tours/${tour.id}`, {
      method: "PATCH",
      headers: { "x-test-user": "alice", cookie: "miu.sid=abc", "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(ok.status).toBe(200);
  });
});

describe("creator API: panorama uploads", () => {
  test("stores a valid equirectangular panorama under tours/<tourId>/", async () => {
    const { as, files, seed } = setup();
    const { tour } = await seed("alice", 0);
    const res = await as("alice").upload(tour.id, await samplePano(), "Lobby");
    expect(res.status).toBe(201);
    const scene = (await res.json()) as Scene;
    expect(scene).toMatchObject({ tourId: tour.id, title: "Lobby", width: 1024, height: 512, order: 0 });
    expect(scene.initialView).toEqual({ yaw: 0, pitch: 0, fov: 75 });
    expect(scene.panoramaKey).toMatch(new RegExp(`^tours/${tour.id}/[A-Za-z0-9_-]+\\.png$`));
    const meta = await files.head(scene.panoramaKey);
    expect(meta).toMatchObject({ contentType: "image/png", size: (await samplePano()).length });
    // the first scene becomes the start scene
    const full = (await (await as("alice").get(`/api/tours/${tour.id}`)).json()) as { tour: Tour; scenes: Scene[] };
    expect(full.tour.startSceneId).toBe(scene.id);
    expect(full.scenes).toHaveLength(1);
  });

  test("rejects non-images (415), wrong aspect (422) and oversize files (413)", async () => {
    const { as, seed } = setup({ maxUploadBytes: 10_000 });
    const { tour } = await seed("alice", 0);
    const api = as("alice");
    const notImage = await api.upload(tour.id, new TextEncoder().encode("<svg onload=alert(1)>"), "x", "image/svg+xml");
    expect(notImage.status).toBe(415);
    const square = await api.upload(tour.id, fakePng(2048, 2048));
    expect(square.status).toBe(422);
    const body = (await square.json()) as { detail: string };
    expect(body.detail).toContain("2:1");
    expect(body.detail).toContain("2048x2048");
    expect((await api.upload(tour.id, fakePng(800, 400))).status).toBe(422); // too small to be a panorama
    const big = await api.upload(tour.id, await samplePano()); // larger than 10 KB
    expect(big.status).toBe(413);
    const missing = await api.call(`/api/tours/${tour.id}/scenes`, { method: "POST", body: new FormData() });
    expect(missing.status).toBe(400);
  });

  test("agents can add a scene with a base64 panorama (JSON)", async () => {
    const { as, seed } = setup();
    const { tour } = await seed("alice", 0);
    const res = await as("alice").post(`/api/tours/${tour.id}/scenes/import`, {
      title: "Imported",
      panoramaBase64: `data:image/png;base64,${b64(await samplePano())}`,
      initialView: { yaw: 45, pitch: 0, fov: 90 },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Scene).initialView.yaw).toBe(45);
    const bad = await as("alice").post(`/api/tours/${tour.id}/scenes/import`, { title: "x", panoramaBase64: "!!!" });
    expect(bad.status).toBe(400);
  });
});

describe("creator API: scenes and hotspots", () => {
  test("rename, initial view, reorder and start scene", async () => {
    const { as, seed } = setup();
    const { tour, scenes } = await seed("alice", 3);
    const api = as("alice");
    const [a, b, c] = scenes as [Scene, Scene, Scene];
    expect((await (await api.patch(`/api/scenes/${b.id}`, { title: "Kitchen", initialView: { yaw: 90, pitch: 5, fov: 60 } })).json()) as Scene).toMatchObject({ title: "Kitchen", initialView: { yaw: 90 } });
    expect((await api.patch(`/api/scenes/${b.id}`, { initialView: { yaw: 200, pitch: 0, fov: 60 } })).status).toBe(422);

    const reordered = await api.put(`/api/tours/${tour.id}/scene-order`, { sceneIds: [c.id, a.id, b.id] });
    expect(reordered.status).toBe(200);
    const full = (await (await api.get(`/api/tours/${tour.id}`)).json()) as { scenes: Scene[] };
    expect(full.scenes.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
    expect((await api.put(`/api/tours/${tour.id}/scene-order`, { sceneIds: [c.id, a.id] })).status).toBe(422);

    expect(((await (await api.patch(`/api/tours/${tour.id}`, { startSceneId: c.id })).json()) as Tour).startSceneId).toBe(c.id);
    const other = await setup().seed("bob", 1);
    expect((await api.patch(`/api/tours/${tour.id}`, { startSceneId: other.scenes[0]!.id })).status).toBe(422);
  });

  test("hotspots: link targets must be scenes of the same tour", async () => {
    const { as, seed } = setup();
    const { scenes } = await seed("alice", 2);
    const { scenes: bobScenes } = await seed("bob", 1, "Bob tour");
    const api = as("alice");
    const [a, b] = scenes as [Scene, Scene];
    const res = await api.post(`/api/scenes/${a.id}/hotspots`, { kind: "link", yaw: 60, pitch: -5, targetSceneId: b.id, title: "Kitchen" });
    expect(res.status).toBe(201);
    const h = (await res.json()) as Hotspot;
    expect(h).toMatchObject({ sceneId: a.id, tourId: a.tourId, kind: "link", targetSceneId: b.id });
    expect((await api.post(`/api/scenes/${a.id}/hotspots`, { kind: "link", yaw: 0, pitch: 0, targetSceneId: bobScenes[0]!.id })).status).toBe(422);
    expect((await api.post(`/api/scenes/${a.id}/hotspots`, { kind: "link", yaw: 0, pitch: 0, targetSceneId: a.id })).status).toBe(422);
    expect((await api.post(`/api/scenes/${a.id}/hotspots`, { kind: "info", yaw: 0, pitch: 100, title: "x" })).status).toBe(422);
    expect((await as("bob").post(`/api/scenes/${a.id}/hotspots`, { kind: "info", yaw: 0, pitch: 0, title: "x" })).status).toBe(403);

    const moved = (await (await api.patch(`/api/hotspots/${h.id}`, { yaw: -30, pitch: 2, title: null })).json()) as Hotspot;
    expect(moved).toMatchObject({ yaw: -30, pitch: 2 });
    expect(moved.title).toBeUndefined();
    expect((await api.patch(`/api/hotspots/${h.id}`, { targetSceneId: bobScenes[0]!.id })).status).toBe(422);
    expect((await as("bob").patch(`/api/hotspots/${h.id}`, { yaw: 1 })).status).toBe(403);
    expect((await api.del(`/api/hotspots/${h.id}`)).status).toBe(204);
    expect((await api.del(`/api/hotspots/${h.id}`)).status).toBe(404);
  });

  test("deleting a scene removes its hotspots, links to it, and its panorama", async () => {
    const { as, seed, files, hotspots } = setup();
    const { tour, scenes } = await seed("alice", 2);
    const api = as("alice");
    const [a, b] = scenes as [Scene, Scene];
    await api.post(`/api/scenes/${a.id}/hotspots`, { kind: "link", yaw: 0, pitch: 0, targetSceneId: b.id });
    await api.post(`/api/scenes/${b.id}/hotspots`, { kind: "info", yaw: 0, pitch: 0, title: "Hi" });
    expect((await api.del(`/api/scenes/${a.id}`)).status).toBe(204);
    expect(await files.head(a.panoramaKey)).toBeUndefined();
    expect((await hotspots.list()).items.map((h) => h.sceneId)).toEqual([b.id]);
    const full = (await (await api.get(`/api/tours/${tour.id}`)).json()) as { tour: Tour };
    expect(full.tour.startSceneId).toBe(b.id);
  });
});

describe("publishing", () => {
  test("publish validates the tour graph and lists every problem", async () => {
    const { as, seed, scenes: sceneRepo, hotspots } = setup();
    const empty = await seed("alice", 0, "Empty");
    const res = await as("alice").post(`/api/tours/${empty.tour.id}/publish`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { problems: { code: string; message: string }[] };
    expect(body.problems.map((p) => p.code)).toContain("no_scenes");
    expect(body.problems.map((p) => p.code)).toContain("no_start_scene");

    const { tour, scenes } = await seed("alice", 2);
    // simulate a dangling link (e.g. written by another tool straight into the repository)
    await hotspots.create({ tourId: tour.id, sceneId: scenes[0]!.id, kind: "link", yaw: 0, pitch: 0, targetSceneId: "gone" });
    await hotspots.create({ tourId: tour.id, sceneId: scenes[0]!.id, kind: "link", yaw: 0, pitch: 0 });
    const bad = (await (await as("alice").post(`/api/tours/${tour.id}/publish`)).json()) as { problems: { code: string; hotspotId?: string }[] };
    expect(bad.problems.map((p) => p.code).sort()).toEqual(["link_missing_target", "link_target_not_in_tour"]);
    expect(bad.problems[0]!.hotspotId).toBeString();
    for (const h of (await hotspots.list()).items) await hotspots.delete(h.id);
    void sceneRepo;

    const ok = await as("alice").post(`/api/tours/${tour.id}/publish`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Tour).status).toBe("published");
    const un = await as("alice").post(`/api/tours/${tour.id}/unpublish`);
    expect(((await un.json()) as Tour).status).toBe("draft");
  });
});

describe("public API and media", () => {
  const published = async () => {
    const s = setup();
    const { tour, scenes } = await s.seed("alice", 2);
    await s.as("alice").post(`/api/scenes/${scenes[0]!.id}/hotspots`, { kind: "link", yaw: 60, pitch: 0, targetSceneId: scenes[1]!.id });
    await s.as("alice").post(`/api/tours/${tour.id}/publish`);
    return { ...s, tour, sceneDocs: scenes };
  };

  test("drafts are 404 publicly", async () => {
    const { as, seed } = setup();
    const { tour } = await seed("alice", 1);
    expect((await as().get(`/api/public/tours/${tour.slug}`)).status).toBe(404);
    expect((await as().get(`/api/public/tours/nope`)).status).toBe(404);
  });

  test("published bundle is cacheable with an ETag and answers 304", async () => {
    const { as, tour, sceneDocs: scenes } = await published();
    const res = await as().get(`/api/public/tours/${tour.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = res.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const bundle = (await res.json()) as { tour: Tour; scenes: Scene[]; hotspots: Hotspot[] };
    expect(bundle.tour.slug).toBe(tour.slug);
    expect(bundle.scenes).toHaveLength(2);
    expect(bundle.hotspots).toHaveLength(1);
    expect("ownerId" in bundle.tour).toBe(false); // no internal ids leak publicly
    const again = await as().call(`/api/public/tours/${tour.slug}`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    // any edit changes the etag
    await new Promise((r) => setTimeout(r, 2));
    await as("alice").patch(`/api/scenes/${scenes[0]!.id}`, { title: "Renamed" });
    const after = await as().call(`/api/public/tours/${tour.slug}`, { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
  });

  test("panoramas: public for published tours with immutable caching and Range", async () => {
    const { as, sceneDocs } = await published();
    const key = sceneDocs[0]!.panoramaKey;
    const res = await as().get(`/media/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(await samplePano()));
    const etag = res.headers.get("etag")!;
    expect((await as().call(`/media/${key}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    const part = await as().call(`/media/${key}`, { headers: { range: "bytes=0-7" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-7/${bytes.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(0, 8));
    expect((await as().call(`/media/${key}`, { headers: { range: "bytes=999999-" } })).status).toBe(416);
  });

  test("panoramas of drafts are visible to the owner only", async () => {
    const { as, seed } = setup();
    const { scenes } = await seed("alice", 1);
    const key = scenes[0]!.panoramaKey;
    expect((await as().get(`/media/${key}`)).status).toBe(404);
    expect((await as("bob").get(`/media/${key}`)).status).toBe(404);
    const own = await as("alice").get(`/media/${key}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toContain("private");
    expect((await as("root").get(`/media/${key}`)).status).toBe(200);
    expect((await as("alice").get(`/media/other/${key}`)).status).toBe(404);
    expect((await as("alice").get(`/media/tours/../secret`)).status).toBe(404);
  });

  test("deleting a tour cascades to scenes, hotspots and stored panoramas", async () => {
    const { as, tour, files, scenes, hotspots } = await published();
    expect((await files.list(`tours/${tour.id}/`)).items).toHaveLength(2);
    expect((await as("alice").del(`/api/tours/${tour.id}`)).status).toBe(204);
    expect((await files.list(`tours/${tour.id}/`)).items).toHaveLength(0);
    expect((await scenes.list()).total).toBe(0);
    expect((await hotspots.list()).total).toBe(0);
    expect((await as().get(`/api/public/tours/${tour.slug}`)).status).toBe(404);
  });
});

describe("agent surface", () => {
  test("JSON routes are documented MCP tools; pages and multipart are not tools", async () => {
    const { app } = setup();
    const tools = listTools(app);
    const names = tools.map((t) => t.name);
    for (const n of ["tour_list", "tour_create", "tour_get", "tour_update", "tour_delete", "scene_import", "scene_update",
      "scene_delete", "scene_reorder", "hotspot_create", "hotspot_update", "hotspot_delete", "tour_publish", "tour_unpublish", "public_tour_get"]) {
      expect(names).toContain(n);
    }
    for (const t of tools) expect(t.description.length).toBeGreaterThan(20);
    expect(names.some((n) => n.includes("editor") || n.includes("assets") || n.includes("media"))).toBe(false);
    expect(names).not.toContain("scene_upload");
    const doc = generateOpenAPI(app) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/api/tours/{id}/scenes");
  });

  test("an agent can build and publish a tour through MCP-shaped JSON calls", async () => {
    const { as } = setup();
    const api = as("alice");
    const tour = (await (await api.post("/api/tours", { title: "Agent tour" })).json()) as Tour;
    const pano = `data:image/png;base64,${b64(await samplePano())}`;
    const a = (await (await api.post(`/api/tours/${tour.id}/scenes/import`, { title: "A", panoramaBase64: pano })).json()) as Scene;
    const b = (await (await api.post(`/api/tours/${tour.id}/scenes/import`, { title: "B", panoramaBase64: pano })).json()) as Scene;
    await api.post(`/api/scenes/${a.id}/hotspots`, { kind: "link", yaw: 10, pitch: 0, targetSceneId: b.id });
    await api.post(`/api/scenes/${b.id}/hotspots`, { kind: "link", yaw: -170, pitch: 0, targetSceneId: a.id });
    expect((await api.post(`/api/tours/${tour.id}/publish`)).status).toBe(200);
    expect((await as().get(`/api/public/tours/${tour.slug}`)).status).toBe(200);
  });
});
