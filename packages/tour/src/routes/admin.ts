// Editor routes: CRUD for tours, scenes, hotspots and floor plans. Every route checks a
// permission (`tours:read` / `tours:write`) through ctx.authorize (e.g. @miujs/access) and is
// scoped to the active org when multi-tenancy is on.
import { route, type Context, type RouteDef } from "miujs";
import { checkKey } from "@miujs/files";
import { hashPassword } from "../crypto.ts";
import { tourErrors } from "../errors.ts";
import { orgScope, type TourRuntime } from "../runtime.ts";
import * as S from "../schemas.ts";
import type { Asset, Hotspot, HotspotInput, Scene, Tour, TourStore } from "../store.ts";

const READ = "tours:read";
const WRITE = "tours:write";
const TAGS = ["tours"];

export async function loadTour(rt: TourRuntime, ctx: Context, ref: string): Promise<{ s: TourStore; tour: Tour }> {
  const s = await rt.data(ctx.env);
  const tour = await s.findTour(ref, orgScope(ctx));
  if (!tour) throw tourErrors.notFound(ref);
  return { s, tour };
}

async function loadScene(s: TourStore, tour: Tour, id: string): Promise<Scene> {
  const scene = await s.getScene(tour.id, id);
  if (!scene) throw tourErrors.sceneNotFound(id);
  return scene;
}

function key(k: string): string {
  checkKey(k);
  return k;
}

/** Validates a full hotspot against its scene and tour. */
async function checkHotspot(s: TourStore, tour: Tour, scene: Scene, h: HotspotInput): Promise<HotspotInput> {
  const xyz = "x" in h.position;
  if (scene.type === "pano360" && xyz) throw tourErrors.invalid("Hotspots on a 360° panorama use { yaw, pitch }", "Send position: { yaw: -180..180, pitch: -90..90 } in degrees.");
  if (scene.type !== "pano360" && !xyz) {
    throw tourErrors.invalid(`Hotspots on a ${scene.type} scene use { x, y, z }`, scene.type === "image" ? "Send position: { x: 0..1, y: 0..1 } (fractions of the image width and height)." : "Send position: { x, y, z } in model units.");
  }
  if (scene.type === "image" && xyz) {
    const p = h.position as { x: number; y: number };
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) throw tourErrors.invalid("Image hotspot positions are fractions from 0 to 1", "Send x and y between 0 and 1.");
  }
  const out: HotspotInput = { kind: h.kind, position: h.position, title: h.title ?? null, body: h.body ?? null, targetSceneId: null, mediaKey: null, url: null };
  switch (h.kind) {
    case "link": {
      if (!h.targetSceneId) throw tourErrors.invalid("Link hotspots need targetSceneId", "Set targetSceneId to the scene this hotspot leads to.");
      if (h.targetSceneId === scene.id) throw tourErrors.invalid("A link hotspot cannot lead to its own scene", "Pick another scene of this tour as targetSceneId.");
      await loadScene(s, tour, h.targetSceneId);
      out.targetSceneId = h.targetSceneId;
      break;
    }
    case "info":
      if (!h.title && !h.body) throw tourErrors.invalid("Info hotspots need a title or body", "Set title and/or body (paragraphs, **bold**, *emphasis*, [links](https://...)).");
      break;
    case "media":
      if (!h.mediaKey) throw tourErrors.invalid("Media hotspots need mediaKey", "Upload the image/video/PDF with @miujs/files and set mediaKey to its key.");
      out.mediaKey = key(h.mediaKey);
      break;
    case "url":
      if (!h.url) throw tourErrors.invalid("URL hotspots need url", "Set url to an http(s) address.");
      out.url = h.url;
      break;
  }
  return out;
}

export interface TourDetail extends Tour {
  scenes: (Scene & { hotspots: Hotspot[]; asset: Pick<Asset, "id" | "status" | "progress" | "error"> | null })[];
  floorPlans: Awaited<ReturnType<TourStore["listFloorPlans"]>>;
}

export async function tourDetail(s: TourStore, tour: Tour): Promise<TourDetail> {
  const [scenes, hotspots, floorPlans, assets] = await Promise.all([s.listScenes(tour.id), s.listHotspots(tour.id), s.listFloorPlans(tour.id), s.listAssets(tour.id)]);
  const byId = new Map(assets.map((a) => [a.id, a]));
  return {
    ...tour,
    scenes: scenes.map((sc) => {
      const a = sc.assetId ? byId.get(sc.assetId) : undefined;
      return { ...sc, hotspots: hotspots.filter((h) => h.sceneId === sc.id), asset: a ? { id: a.id, status: a.status, progress: a.progress, error: a.error } : null };
    }),
    floorPlans,
  };
}

export function adminRoutes(rt: TourRuntime): RouteDef[] {
  const base = rt.basePath;

  const list = route.get(base, {
    name: "tours_list",
    summary: "List tours (newest first), optionally filtered by status or visibility",
    tags: TAGS,
    permission: READ,
    query: S.listQuery,
    handler: async (ctx) => {
      const s = await rt.data(ctx.env);
      const tours = await s.listTours({ orgId: orgScope(ctx as unknown as Context), ...ctx.query });
      return { tours };
    },
  });

  const create = route.post(base, {
    name: "tours_create",
    summary: "Create a tour (starts as a private draft)",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    status: 201,
    body: S.createTourBody,
    handler: async (ctx) => {
      const s = await rt.data(ctx.env);
      if (await s.slugTaken(ctx.body.slug)) throw tourErrors.slugTaken(ctx.body.slug);
      const org = orgScope(ctx as unknown as Context);
      return s.createTour({ ...ctx.body, orgId: typeof org === "string" ? org : null });
    },
  });

  const get = route.get(`${base}/:tour`, {
    name: "tours_get",
    summary: "Get a tour by id or slug, with its scenes, hotspots, floor plans and asset states",
    tags: TAGS,
    permission: READ,
    params: S.tourParams,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      return tourDetail(s, tour);
    },
  });

  const update = route.patch(`${base}/:tour`, {
    name: "tours_update",
    summary: "Update a tour: title, slug, status, visibility, privacy, watermark, embed origins, start scene, password",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.tourParams,
    body: S.updateTourBody,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      const { password, ...rest } = ctx.body;
      if (rest.slug && (await s.slugTaken(rest.slug, tour.id))) throw tourErrors.slugTaken(rest.slug);
      if (rest.startSceneId) await loadScene(s, tour, rest.startSceneId);
      const patch: Parameters<TourStore["updateTour"]>[1] = { ...rest };
      if (password !== undefined) patch.passwordHash = password === null ? null : await hashPassword(password);
      return s.updateTour(tour.id, patch);
    },
  });

  const remove = route.delete(`${base}/:tour`, {
    name: "tours_delete",
    summary: "Delete a tour with its scenes, hotspots, floor plans and analytics (files stay in the store)",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.tourParams,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      await s.deleteTour(tour.id);
    },
  });

  const sceneCreate = route.post(`${base}/:tour/scenes`, {
    name: "tours_scene_create",
    summary: "Add a scene (pano360, model3d or image) to a tour",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    status: 201,
    params: S.tourParams,
    body: S.createSceneBody,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      return s.createScene(tour.id, ctx.body);
    },
  });

  const sceneUpdate = route.patch(`${base}/:tour/scenes/:scene`, {
    name: "tours_scene_update",
    summary: "Update a scene's title, initial view, floor or order",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.sceneParams,
    body: S.updateSceneBody,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      await loadScene(s, tour, ctx.params.scene);
      return s.updateScene(tour.id, ctx.params.scene, ctx.body);
    },
  });

  const sceneDelete = route.delete(`${base}/:tour/scenes/:scene`, {
    name: "tours_scene_delete",
    summary: "Delete a scene, its hotspots and the links that lead to it",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.sceneParams,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      await loadScene(s, tour, ctx.params.scene);
      await s.deleteScene(tour.id, ctx.params.scene);
    },
  });

  const hotspotCreate = route.post(`${base}/:tour/scenes/:scene/hotspots`, {
    name: "tours_hotspot_create",
    summary: "Add a hotspot (link, info, media or url) to a scene",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    status: 201,
    params: S.sceneParams,
    body: S.createHotspotBody,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      const scene = await loadScene(s, tour, ctx.params.scene);
      return s.createHotspot(tour.id, scene.id, await checkHotspot(s, tour, scene, ctx.body as HotspotInput));
    },
  });

  const hotspotUpdate = route.patch(`${base}/:tour/hotspots/:hotspot`, {
    name: "tours_hotspot_update",
    summary: "Update a hotspot",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.hotspotParams,
    body: S.updateHotspotBody,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      const h = await s.getHotspot(tour.id, ctx.params.hotspot);
      if (!h) throw tourErrors.hotspotNotFound(ctx.params.hotspot);
      const scene = await loadScene(s, tour, h.sceneId);
      const merged = { ...h, ...(ctx.body as Partial<HotspotInput>) } as HotspotInput;
      return s.replaceHotspot(tour.id, h.id, await checkHotspot(s, tour, scene, merged));
    },
  });

  const hotspotDelete = route.delete(`${base}/:tour/hotspots/:hotspot`, {
    name: "tours_hotspot_delete",
    summary: "Delete a hotspot",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.hotspotParams,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      if (!(await s.getHotspot(tour.id, ctx.params.hotspot))) throw tourErrors.hotspotNotFound(ctx.params.hotspot);
      await s.deleteHotspot(tour.id, ctx.params.hotspot);
    },
  });

  const floorPut = route.put(`${base}/:tour/floorplans/:floor`, {
    name: "tours_floorplan_put",
    summary: "Create or replace the floor plan of one floor: plan image key and one marker per scene",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.floorParams,
    body: S.floorPlanBody,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      key(ctx.body.imageKey);
      for (const m of ctx.body.markers) await loadScene(s, tour, m.sceneId);
      return s.putFloorPlan(tour.id, ctx.params.floor, ctx.body);
    },
  });

  const floorDelete = route.delete(`${base}/:tour/floorplans/:floor`, {
    name: "tours_floorplan_delete",
    summary: "Delete the floor plan of one floor",
    tags: TAGS,
    permission: WRITE,
    mcp: false,
    params: S.floorParams,
    handler: async (ctx) => {
      const { s, tour } = await loadTour(rt, ctx as unknown as Context, ctx.params.tour);
      if (!(await s.deleteFloorPlan(tour.id, ctx.params.floor))) throw tourErrors.floorPlanNotFound(ctx.params.floor);
    },
  });

  return [list, create, get, update, remove, sceneCreate, sceneUpdate, sceneDelete, hotspotCreate, hotspotUpdate, hotspotDelete, floorPut, floorDelete];
}
