import { describe, expect, test } from "bun:test";
import { migrate, sqlite } from "@miujs/db";
import { tourMigrations } from "../src/migrations.ts";
import { TourStore } from "../src/store.ts";

async function fresh() {
  const db = sqlite(":memory:");
  await migrate(db, tourMigrations);
  let n = 0;
  return { db, store: new TourStore(db, () => 1_000 + n++) };
}

describe("migrations", () => {
  test("apply once and create the tour tables", async () => {
    const db = sqlite(":memory:");
    expect(await migrate(db, tourMigrations)).toEqual(tourMigrations.map((m) => m.id));
    expect(await migrate(db, tourMigrations)).toEqual([]);
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'miu_tour%' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "miu_tour_assets",
      "miu_tour_daily",
      "miu_tour_daily_hotspots",
      "miu_tour_daily_scenes",
      "miu_tour_events",
      "miu_tour_floorplan_markers",
      "miu_tour_floorplans",
      "miu_tour_hotspots",
      "miu_tour_scenes",
      "miu_tours",
    ]);
  });
});

describe("TourStore", () => {
  test("creates a tour with defaults and finds it by id or slug", async () => {
    const { store } = await fresh();
    const tour = await store.createTour({ title: "12 Elm St", slug: "12-elm-st" });
    expect(tour).toMatchObject({
      title: "12 Elm St",
      slug: "12-elm-st",
      status: "draft",
      visibility: "private",
      orgId: null,
      privacy: "standard",
      watermark: null,
      allowedEmbedOrigins: [],
      hasPassword: false,
      startSceneId: null,
    });
    expect(tour.id).toMatch(/^tour_[0-9a-f]{20}$/);
    expect((await store.findTour(tour.id))?.slug).toBe("12-elm-st");
    expect((await store.findTour("12-elm-st"))?.id).toBe(tour.id);
    expect(await store.findTour("nope")).toBeNull();
  });

  test("org scoping hides other orgs' tours", async () => {
    const { store } = await fresh();
    const a = await store.createTour({ title: "A", slug: "a", orgId: "org_a" });
    await store.createTour({ title: "B", slug: "b", orgId: "org_b" });
    expect(await store.findTour(a.id, "org_b")).toBeNull();
    expect((await store.findTour(a.id, "org_a"))?.id).toBe(a.id);
    expect((await store.listTours({ orgId: "org_a" })).map((t) => t.slug)).toEqual(["a"]);
    expect((await store.listTours({})).map((t) => t.slug).sort()).toEqual(["a", "b"]);
  });

  test("scenes keep their order; hotspots and markers cascade on delete", async () => {
    const { store, db } = await fresh();
    const tour = await store.createTour({ title: "T", slug: "t" });
    const s1 = await store.createScene(tour.id, { title: "Hall", type: "pano360" });
    const s2 = await store.createScene(tour.id, { title: "Kitchen", type: "pano360", initialView: { yaw: 90, pitch: -5, fov: 60 }, floor: 1 });
    expect(s1.order).toBe(0);
    expect(s2.order).toBe(1);
    expect(s2.initialView).toEqual({ yaw: 90, pitch: -5, fov: 60 });
    expect(s1.initialView).toEqual({ yaw: 0, pitch: 0, fov: 75 });
    await store.createHotspot(tour.id, s1.id, { kind: "link", position: { yaw: 10, pitch: 0 }, targetSceneId: s2.id });
    await store.putFloorPlan(tour.id, 1, { title: "Ground", imageKey: "fp.png", markers: [{ sceneId: s2.id, x: 0.5, y: 0.25 }] });
    expect((await store.listFloorPlans(tour.id))[0].markers).toEqual([{ sceneId: s2.id, x: 0.5, y: 0.25 }]);
    await store.deleteTour(tour.id);
    for (const table of ["miu_tour_scenes", "miu_tour_hotspots", "miu_tour_floorplans", "miu_tour_floorplan_markers"]) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(0);
    }
  });

  test("deleting a scene removes links that point to it", async () => {
    const { store } = await fresh();
    const tour = await store.createTour({ title: "T", slug: "t" });
    const s1 = await store.createScene(tour.id, { title: "A", type: "pano360" });
    const s2 = await store.createScene(tour.id, { title: "B", type: "pano360" });
    await store.createHotspot(tour.id, s1.id, { kind: "link", position: { yaw: 0, pitch: 0 }, targetSceneId: s2.id });
    await store.deleteScene(tour.id, s2.id);
    expect(await store.listHotspots(tour.id)).toEqual([]);
  });

  test("3D hotspots keep xyz", async () => {
    const { store } = await fresh();
    const tour = await store.createTour({ title: "T", slug: "t" });
    const s = await store.createScene(tour.id, { title: "Chair", type: "model3d" });
    const h = await store.createHotspot(tour.id, s.id, { kind: "info", position: { x: 1, y: 2.5, z: -3 }, title: "Leg", body: "Oak" });
    expect(h.position).toEqual({ x: 1, y: 2.5, z: -3 });
    expect((await store.listHotspots(tour.id))[0]).toMatchObject({ kind: "info", title: "Leg", body: "Oak" });
  });

  test("asset status and progress updates", async () => {
    const { store } = await fresh();
    const tour = await store.createTour({ title: "T", slug: "t" });
    const s = await store.createScene(tour.id, { title: "A", type: "pano360" });
    const a = await store.createAsset({ tourId: tour.id, sceneId: s.id, kind: "pano", sourceKey: "src.jpg", contentType: "image/jpeg", size: 10 });
    expect(a).toMatchObject({ status: "queued", progress: 0, output: null, error: null });
    expect((await store.getScene(tour.id, s.id))?.assetId).toBe(a.id);
    await store.updateAsset(a.id, { status: "processing", progress: 0.5 });
    await store.updateAsset(a.id, { status: "ready", progress: 1, output: { layout: "glb", key: "x.glb" } });
    expect(await store.getAsset(a.id)).toMatchObject({ status: "ready", progress: 1, output: { layout: "glb", key: "x.glb" } });
  });
});
