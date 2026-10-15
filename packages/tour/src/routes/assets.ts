// Asset routes: upload a scene's source file (or attach one uploaded with resumable multipart
// uploads), list processing states, retry failures.
import { route, t, type Context, type RouteDef } from "miujs";
import { checkKey, sniff, type FilesClient } from "@miujs/files";
import { tourErrors } from "../errors.ts";
import { JOB_NAMES, STEP_FOR, type TourJobs } from "../jobs.ts";
import type { TourRuntime } from "../runtime.ts";
import * as S from "../schemas.ts";
import type { Asset, AssetKind, Scene, Tour, TourStore } from "../store.ts";
import { loadTour } from "./admin.ts";

const MiB = 1024 * 1024;
export const KIND_FOR: Record<Scene["type"], AssetKind> = { pano360: "pano", model3d: "model", image: "image" };
export const ALLOWED: Record<AssetKind, string[]> = {
  pano: ["image/jpeg", "image/png", "image/webp"],
  model: ["model/gltf-binary"],
  image: ["image/jpeg", "image/png", "image/webp"],
};

interface QueueLike {
  dispatch(job: unknown, input: unknown): Promise<{ id: string }>;
}

function filesOf(ctx: Context): FilesClient {
  const f = (ctx as unknown as { files?: FilesClient }).files;
  if (!f) throw tourErrors.filesMissing();
  return f;
}

function queueOf(ctx: Context): QueueLike {
  const q = (ctx as unknown as { queue?: QueueLike }).queue;
  if (!q) throw tourErrors.queueMissing();
  return q;
}

/** Records the asset and queues its processing step. Returns the response for the route. */
async function start(rt: TourRuntime, jobs: TourJobs, ctx: Context, s: TourStore, tour: Tour, scene: Scene, file: { key: string; contentType: string; size: number }): Promise<Response> {
  const kind = KIND_FOR[scene.type];
  const step = STEP_FOR[kind];
  if (!step) {
    const asset = await s.createAsset({ tourId: tour.id, sceneId: scene.id, kind, sourceKey: file.key, contentType: file.contentType, size: file.size, status: "ready" });
    return Response.json({ asset }, { status: 201 });
  }
  const asset = await s.createAsset({ tourId: tour.id, sceneId: scene.id, kind, sourceKey: file.key, contentType: file.contentType, size: file.size });
  await queueOf(ctx).dispatch(jobs[step], { assetId: asset.id, origin: ctx.url.origin });
  return Response.json({ asset }, { status: 202 });
}

async function loadScene(s: TourStore, tour: Tour, id: string): Promise<Scene> {
  const scene = await s.getScene(tour.id, id);
  if (!scene) throw tourErrors.sceneNotFound(id);
  return scene;
}

export function assetRoutes(rt: TourRuntime, jobs: TourJobs): RouteDef[] {
  const base = rt.basePath;
  const limits = {
    pano: rt.opts.maxUploadSize?.pano ?? 200 * MiB,
    model: rt.opts.maxUploadSize?.model ?? 200 * MiB,
    image: rt.opts.maxUploadSize?.image ?? 50 * MiB,
  };

  const upload = route.post(`${base}/:tour/scenes/:scene/upload`, {
    name: "tours_scene_upload",
    summary: "Upload a scene's source file (raw body or multipart field `file`); its type is checked from its bytes, then processing is queued",
    description: "For files larger than a single request allows, use the @miujs/files multipart upload routes, then PUT /tours/:tour/scenes/:scene/asset with the key.",
    tags: ["tours"],
    permission: "tours:write",
    mcp: false,
    params: S.sceneParams,
    maxBodySize: Math.max(limits.pano, limits.model, limits.image) + MiB,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadTour(rt, ctx, c.params.tour);
      const scene = await loadScene(s, tour, c.params.scene);
      const kind = KIND_FOR[scene.type];
      const files = filesOf(ctx);
      if (STEP_FOR[kind]) queueOf(ctx);
      const [f] = await files.handleUpload(ctx, { maxSize: limits[kind], allowedTypes: ALLOWED[kind], prefix: `tours/${tour.id}/src/` });
      return start(rt, jobs, ctx, s, tour, scene, f);
    },
  });

  const attach = route.put(`${base}/:tour/scenes/:scene/asset`, {
    name: "tours_scene_attach",
    summary: "Use an already uploaded file (e.g. from a resumable multipart upload) as a scene's source, and queue its processing",
    tags: ["tours"],
    permission: "tours:write",
    mcp: false,
    params: S.sceneParams,
    body: t.object({ key: t.string({ maxLength: 1024 }) }),
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadTour(rt, ctx, c.params.tour);
      const scene = await loadScene(s, tour, c.params.scene);
      const key = checkKey(c.body.key);
      const kind = KIND_FOR[scene.type];
      if (STEP_FOR[kind]) queueOf(ctx);
      const obj = await rt.files(ctx.env).get(key, { range: { offset: 0, length: 16 } });
      if (!obj) throw tourErrors.sourceMissing(key);
      const head = new Uint8Array(await new Response(obj.body).arrayBuffer());
      const type = sniff(head);
      if (!type || !ALLOWED[kind].includes(type)) throw tourErrors.assetType(scene.type, type ?? "unrecognized", ALLOWED[kind]);
      return start(rt, jobs, ctx, s, tour, scene, { key, contentType: type, size: obj.size });
    },
  });

  const list = route.get(`${base}/:tour/assets`, {
    name: "tours_assets",
    summary: "List a tour's assets with their processing state (queued, processing, ready, failed), progress and errors",
    tags: ["tours"],
    permission: "tours:read",
    params: S.tourParams,
    handler: async (c) => {
      const { s, tour } = await loadTour(rt, c as unknown as Context, c.params.tour);
      return { assets: await s.listAssets(tour.id) };
    },
  });

  const retry = route.post(`${base}/:tour/assets/:asset/retry`, {
    name: "tours_asset_retry",
    summary: "Queue a failed (or stuck) asset for processing again",
    tags: ["tours"],
    permission: "tours:write",
    mcp: false,
    params: S.assetParams,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadTour(rt, ctx, c.params.tour);
      const asset = await s.getAsset(c.params.asset);
      if (!asset || asset.tourId !== tour.id) throw tourErrors.assetNotFound(c.params.asset);
      const step = STEP_FOR[asset.kind];
      if (!step) return Response.json({ asset }, { status: 200 });
      const q = queueOf(ctx);
      await s.updateAsset(asset.id, { status: "queued", progress: 0, error: null });
      await q.dispatch(jobs[step], { assetId: asset.id, origin: ctx.url.origin });
      return Response.json({ asset: (await s.getAsset(asset.id)) as Asset }, { status: 202 });
    },
  });

  return [upload, attach, list, retry];
}

export { JOB_NAMES };
