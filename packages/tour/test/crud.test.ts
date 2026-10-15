import { describe, expect, test } from "bun:test";
import { call, editor, json, reader, seedTour, setup } from "./helpers.ts";

describe("tours CRUD", () => {
  test("creating needs tours:write", async () => {
    const { app } = setup();
    expect((await call(app, "/tours", json("POST", { title: "A", slug: "a" }))).status).toBe(401);
    expect((await call(app, "/tours", json("POST", { title: "A", slug: "a" }, reader))).status).toBe(403);
    const ok = await call(app, "/tours", json("POST", { title: "A", slug: "a" }, editor));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: "A", slug: "a", status: "draft", visibility: "private", hasPassword: false });
  });

  test("slugs are validated and unique", async () => {
    const { app } = setup();
    const bad = await call(app, "/tours", json("POST", { title: "A", slug: "Not A Slug" }, editor));
    expect(bad.status).toBe(400);
    await call(app, "/tours", json("POST", { title: "A", slug: "a" }, editor));
    const dup = await call(app, "/tours", json("POST", { title: "B", slug: "a" }, editor));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("MIU_E_TOUR_SLUG_TAKEN");
    expect(dup.body.error.fix).toBeString();
  });

  test("list and get need tours:read; get includes scenes, hotspots and floor plans", async () => {
    const { app } = setup();
    const { tour, s1, s2 } = await seedTour(app);
    await call(app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "link", position: { yaw: 30, pitch: -10 }, targetSceneId: s2.id }, editor));
    await call(app, `/tours/${tour.id}/floorplans/0`, json("PUT", { title: "Ground", imageKey: "plans/ground.png", markers: [{ sceneId: s1.id, x: 0.2, y: 0.3 }] }, editor));
    expect((await call(app, "/tours")).status).toBe(401);
    const list = await call(app, "/tours", { headers: reader });
    expect(list.status).toBe(200);
    expect(list.body.tours.map((t: any) => t.slug)).toEqual(["12-elm-st"]);
    const got = await call(app, `/tours/12-elm-st`, { headers: reader });
    expect(got.status).toBe(200);
    expect(got.body.scenes.map((s: any) => s.title)).toEqual(["Hall", "Kitchen"]);
    expect(got.body.scenes[0].hotspots[0]).toMatchObject({ kind: "link", position: { yaw: 30, pitch: -10 }, targetSceneId: s2.id });
    expect(got.body.floorPlans[0]).toMatchObject({ floor: 0, title: "Ground", markers: [{ sceneId: s1.id, x: 0.2, y: 0.3 }] });
  });

  test("patch updates fields; the password is hashed and never returned", async () => {
    const { app } = setup();
    const { tour } = await seedTour(app);
    const r = await call(
      app,
      `/tours/${tour.id}`,
      json("PATCH", { status: "published", visibility: "public", watermark: "For sale - Acme Realty", password: "hunter22", allowedEmbedOrigins: ["https://listings.example.com"] }, editor),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "published", visibility: "public", watermark: "For sale - Acme Realty", hasPassword: true, allowedEmbedOrigins: ["https://listings.example.com"] });
    expect(r.text).not.toContain("hunter22");
    expect(r.text).not.toContain("pbkdf2");
    const cleared = await call(app, `/tours/${tour.id}`, json("PATCH", { password: null }, editor));
    expect(cleared.body.hasPassword).toBe(false);
  });

  test("embed origins must be origins", async () => {
    const { app } = setup();
    const { tour } = await seedTour(app);
    for (const bad of ["*", "https://a.com/path", "javascript:x", "https://a.com; script-src *"]) {
      const r = await call(app, `/tours/${tour.id}`, json("PATCH", { allowedEmbedOrigins: [bad] }, editor));
      expect(r.status).toBe(400);
    }
    const ok = await call(app, `/tours/${tour.id}`, json("PATCH", { allowedEmbedOrigins: ["'self'", "https://a.example.com:8443", "https://*.example.org"] }, editor));
    expect(ok.status).toBe(200);
  });

  test("the start scene must belong to the tour", async () => {
    const { app } = setup();
    const { tour, s2 } = await seedTour(app);
    expect((await call(app, `/tours/${tour.id}`, json("PATCH", { startSceneId: "scn_nope" }, editor))).status).toBe(404);
    expect((await call(app, `/tours/${tour.id}`, json("PATCH", { startSceneId: s2.id }, editor))).body.startSceneId).toBe(s2.id);
  });

  test("delete removes the tour", async () => {
    const { app } = setup();
    const { tour } = await seedTour(app);
    expect((await call(app, `/tours/${tour.id}`, { method: "DELETE", headers: editor })).status).toBe(204);
    const gone = await call(app, `/tours/${tour.id}`, { headers: reader });
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("MIU_E_TOUR_NOT_FOUND");
  });

  test("tours are scoped to the active org", async () => {
    const { app } = setup();
    const a = await call(app, "/tours", json("POST", { title: "A", slug: "a" }, { ...editor, "x-org": "org_a" }));
    expect(a.body.orgId).toBe("org_a");
    await call(app, "/tours", json("POST", { title: "B", slug: "b" }, { ...editor, "x-org": "org_b" }));
    const listA = await call(app, "/tours", { headers: { ...reader, "x-org": "org_a" } });
    expect(listA.body.tours.map((t: any) => t.slug)).toEqual(["a"]);
    expect((await call(app, `/tours/${a.body.id}`, { headers: { ...reader, "x-org": "org_b" } })).status).toBe(404);
    expect((await call(app, `/tours/${a.body.id}`, json("PATCH", { title: "x" }, { ...editor, "x-org": "org_b" }))).status).toBe(404);
  });
});

describe("scenes and hotspots", () => {
  test("scene create, update, delete", async () => {
    const { app } = setup();
    const { tour, s1 } = await seedTour(app);
    const up = await call(app, `/tours/${tour.id}/scenes/${s1.id}`, json("PATCH", { title: "Entry", initialView: { yaw: 45 }, floor: 2 }, editor));
    expect(up.body).toMatchObject({ title: "Entry", initialView: { yaw: 45, pitch: 0, fov: 75 }, floor: 2 });
    const bad = await call(app, `/tours/${tour.id}/scenes`, json("POST", { title: "X", type: "video" }, editor));
    expect(bad.status).toBe(400);
    const badView = await call(app, `/tours/${tour.id}/scenes/${s1.id}`, json("PATCH", { initialView: { pitch: 120 } }, editor));
    expect(badView.status).toBe(400);
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}`, { method: "DELETE", headers: editor })).status).toBe(204);
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}`, json("PATCH", { title: "x" }, editor))).body.error.code).toBe("MIU_E_TOUR_SCENE_NOT_FOUND");
  });

  test("link hotspots need a target scene in the same tour", async () => {
    const { app } = setup();
    const { tour, s1, s2 } = await seedTour(app);
    const other = await seedTour(app, { slug: "other" });
    const path = `/tours/${tour.id}/scenes/${s1.id}/hotspots`;
    expect((await call(app, path, json("POST", { kind: "link", position: { yaw: 0, pitch: 0 } }, editor))).body.error.code).toBe("MIU_E_TOUR_INVALID");
    expect((await call(app, path, json("POST", { kind: "link", position: { yaw: 0, pitch: 0 }, targetSceneId: other.s1.id }, editor))).status).toBe(404);
    expect((await call(app, path, json("POST", { kind: "link", position: { yaw: 0, pitch: 0 }, targetSceneId: s1.id }, editor))).body.error.code).toBe("MIU_E_TOUR_INVALID");
    expect((await call(app, path, json("POST", { kind: "link", position: { yaw: 0, pitch: 0 }, targetSceneId: s2.id }, editor))).status).toBe(201);
  });

  test("url, media and info hotspots validate their fields", async () => {
    const { app } = setup();
    const { tour, s1 } = await seedTour(app);
    const path = `/tours/${tour.id}/scenes/${s1.id}/hotspots`;
    const pos = { yaw: 10, pitch: 5 };
    expect((await call(app, path, json("POST", { kind: "url", position: pos }, editor))).status).toBe(400);
    expect((await call(app, path, json("POST", { kind: "url", position: pos, url: "javascript:alert(1)" }, editor))).status).toBe(400);
    expect((await call(app, path, json("POST", { kind: "url", position: pos, url: "https://example.com/brochure" }, editor))).status).toBe(201);
    expect((await call(app, path, json("POST", { kind: "media", position: pos }, editor))).status).toBe(400);
    expect((await call(app, path, json("POST", { kind: "media", position: pos, mediaKey: "media/clip.mp4", title: "Walkthrough" }, editor))).status).toBe(201);
    expect((await call(app, path, json("POST", { kind: "info", position: pos }, editor))).status).toBe(400);
    expect((await call(app, path, json("POST", { kind: "info", position: pos, title: "Oven", body: "**Gas** oven" }, editor))).status).toBe(201);
  });

  test("hotspot positions match the scene type", async () => {
    const { app } = setup();
    const { tour, s1 } = await seedTour(app);
    const model = (await call(app, `/tours/${tour.id}/scenes`, json("POST", { title: "Chair", type: "model3d" }, editor))).body;
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "info", title: "x", position: { x: 1, y: 2, z: 3 } }, editor))).status).toBe(400);
    expect((await call(app, `/tours/${tour.id}/scenes/${model.id}/hotspots`, json("POST", { kind: "info", title: "x", position: { yaw: 1, pitch: 2 } }, editor))).status).toBe(400);
    expect((await call(app, `/tours/${tour.id}/scenes/${model.id}/hotspots`, json("POST", { kind: "info", title: "x", position: { x: 1, y: 2, z: 3 } }, editor))).status).toBe(201);
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "info", title: "x", position: { yaw: 200, pitch: 0 } }, editor))).status).toBe(400);
  });

  test("hotspot update and delete", async () => {
    const { app } = setup();
    const { tour, s1 } = await seedTour(app);
    const h = (await call(app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "info", title: "Oven", position: { yaw: 1, pitch: 2 } }, editor))).body;
    const up = await call(app, `/tours/${tour.id}/hotspots/${h.id}`, json("PATCH", { title: "Range", position: { yaw: 5, pitch: 6 } }, editor));
    expect(up.body).toMatchObject({ title: "Range", position: { yaw: 5, pitch: 6 } });
    const toUrl = await call(app, `/tours/${tour.id}/hotspots/${h.id}`, json("PATCH", { kind: "url" }, editor));
    expect(toUrl.status).toBe(400);
    expect((await call(app, `/tours/${tour.id}/hotspots/${h.id}`, { method: "DELETE", headers: editor })).status).toBe(204);
    expect((await call(app, `/tours/${tour.id}/hotspots/${h.id}`, { method: "DELETE", headers: editor })).body.error.code).toBe("MIU_E_TOUR_HOTSPOT_NOT_FOUND");
  });

  test("floor plan markers must point at scenes of the tour and stay inside the plan", async () => {
    const { app } = setup();
    const { tour, s1 } = await seedTour(app);
    const path = `/tours/${tour.id}/floorplans/1`;
    expect((await call(app, path, json("PUT", { imageKey: "p.png", markers: [{ sceneId: "scn_x", x: 0.1, y: 0.1 }] }, editor))).status).toBe(404);
    expect((await call(app, path, json("PUT", { imageKey: "p.png", markers: [{ sceneId: s1.id, x: 1.5, y: 0.1 }] }, editor))).status).toBe(400);
    expect((await call(app, path, json("PUT", { imageKey: "../p.png", markers: [] }, editor))).status).toBe(400);
    expect((await call(app, path, json("PUT", { imageKey: "p.png", markers: [{ sceneId: s1.id, x: 1, y: 0 }] }, editor))).status).toBe(200);
    expect((await call(app, path, { method: "DELETE", headers: editor })).status).toBe(204);
    expect((await call(app, path, { method: "DELETE", headers: editor })).status).toBe(404);
  });
});

describe("MCP", () => {
  test("read routes are MCP tools; writes are not", async () => {
    const { app } = setup();
    await app.ready();
    const names = app.tools().map((t) => t.name);
    for (const n of ["tours_list", "tours_get", "tours_manifest", "tours_assets", "tours_stats"]) expect(names).toContain(n);
    for (const n of ["tours_create", "tours_update", "tours_delete", "tours_scene_create"]) expect(names).not.toContain(n);
    const info = app.inspect();
    const get = info.routes.find((r: any) => r.name === "tours_get");
    expect(get?.permission).toBe("tours:read");
    expect(get?.summary).toBeString();
    expect(info.routes.find((r: any) => r.name === "tours_create")?.permission).toBe("tours:write");
  });
});
