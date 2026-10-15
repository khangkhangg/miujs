// The viewer manifest: everything a viewer needs for one tour, with signed asset URLs.
//
// URLs: single files (previews, models, plan images, media) are @miujs/files signed URLs;
// tile pyramids get one prefix-scoped tour token, served by GET /tours/_tiles/:token/*path,
// because signing thousands of tiles one by one would not scale.
//
// Caching: public tours sign with an expiry aligned to the day (valid 6-7 days), so every
// visitor gets the same URLs for a day and browsers/CDNs can cache them. Private, unlisted,
// shared and preview access get short-lived URLs (default 10 minutes) and `no-store`.
import type { Context } from "miujs";
import type { FilesClient } from "@miujs/files";
import type { ViewAccess } from "./access.ts";
import { signTourToken } from "./crypto.ts";
import { tourErrors } from "./errors.ts";
import type { ModelResult, PanoramaResult } from "./processor.ts";
import { richText } from "./richtext.ts";
import type { TourRuntime } from "./runtime.ts";
import type { Asset, HotspotKind, HotspotPosition, SceneType, Tour, TourPrivacy, TourStore, View } from "./store.ts";

const DAY = 86_400;

export type ManifestAsset =
  | { status: "queued" | "processing" | "failed"; progress: number }
  | ({ status: "ready"; progress: number } & (
      | { layout: "cube"; tileSize: number; faceSize: number; levels: { size: number }[]; tiles: string; preview?: string }
      | { layout: "equirect-tiles"; tileSize: number; levels: { width: number; cols: number; rows: number }[]; tiles: string; preview?: string }
      | { layout: "equirect"; sources: { width: number; url: string }[]; preview?: string }
      | { layout: "glb"; url: string; requires: string[] }
      | { layout: "image"; url: string }
    ));

export interface ManifestHotspot {
  id: string;
  kind: HotspotKind;
  position: HotspotPosition;
  targetSceneId?: string;
  title?: string;
  /** Safe HTML (see richText). */
  bodyHtml?: string;
  media?: { url: string; contentType: string | null };
  url?: string;
}

export interface Manifest {
  version: 1;
  tour: { id: string; slug: string; title: string; description: string | null; watermark: string | null; privacy: TourPrivacy; startSceneId: string | null };
  scenes: { id: string; title: string; type: SceneType; floor: number | null; initialView: View; asset: ManifestAsset | null; hotspots: ManifestHotspot[] }[];
  floorPlans: { floor: number; title: string | null; image: { url: string }; markers: { sceneId: string; x: number; y: number }[] }[];
  /** Where the viewer sends beacon events, or null when analytics are off. */
  analytics: { url: string } | null;
  /** Realtime rooms path for live guided tours (join codes), or null. */
  live: { path: string } | null;
  /** When the signed URLs stop working (seconds since the epoch). Fetch the manifest again before. */
  expiresAt: number;
}

export function filesOf(ctx: Context): FilesClient {
  const f = (ctx as unknown as { files?: FilesClient }).files;
  if (!f) throw tourErrors.filesMissing();
  return f;
}

/** Expiry (seconds) for URLs handed out under `access`. */
export function urlExpiry(rt: TourRuntime, access: ViewAccess, nowSec: number): number {
  if (access === "public") {
    const days = Math.max(1, Math.min(6, Math.floor((rt.opts.urls?.publicTtl ?? 6 * DAY) / DAY)));
    return (Math.floor(nowSec / DAY) + days + 1) * DAY;
  }
  return nowSec + (rt.opts.urls?.privateTtl ?? 600);
}

export async function buildManifest(rt: TourRuntime, ctx: Context, s: TourStore, tour: Tour, access: ViewAccess, livePath: string | null, share?: string): Promise<Manifest> {
  const files = filesOf(ctx);
  const origin = ctx.url.origin;
  // Files signs relative to the wall clock, so align with it (not rt.now) to keep URLs stable.
  const wall = Math.floor(Date.now() / 1000);
  const exp = urlExpiry(rt, access, wall);
  const secrets = rt.secrets(ctx.env, ctx.log);
  const sign = (key: string) => files.signedUrl(key, { expiresIn: Math.max(1, exp - wall) });
  const tiles = async (prefix: string, pattern: string) => {
    const token = await signTourToken(secrets, access === "public" ? { p: "tiles", tour: tour.id, prefix, e: exp, pub: 1 } : { p: "tiles", tour: tour.id, prefix, e: exp });
    return `${origin}${rt.basePath}/_tiles/${token}/${pattern}`;
  };
  const urlOf = (src: { key?: string; url?: string }) => (src.key ? sign(src.key) : Promise.resolve(src.url!));

  const assetView = async (a: Asset | undefined): Promise<ManifestAsset | null> => {
    if (!a) return null;
    if (a.status !== "ready") return { status: a.status, progress: a.progress };
    const ready = { status: "ready" as const, progress: 1 };
    if (a.kind === "image") return { ...ready, layout: "image", url: await sign(a.sourceKey) };
    if (a.kind === "model") {
      const o = a.output as ModelResult;
      return { ...ready, layout: "glb", url: await urlOf(o), requires: o.requires ?? [] };
    }
    const o = a.output as PanoramaResult;
    const preview = o.preview ? await sign(o.preview) : undefined;
    const withPreview = <T extends object>(v: T) => (preview ? { ...v, preview } : v);
    if (o.layout === "cube") {
      return withPreview({ ...ready, layout: "cube" as const, tileSize: o.tileSize, faceSize: o.faceSize, levels: o.levels, tiles: await tiles(o.prefix, `{level}/{face}/{row}_{col}.${o.ext}`) });
    }
    if (o.layout === "equirect-tiles") {
      return withPreview({ ...ready, layout: "equirect-tiles" as const, tileSize: o.tileSize, levels: o.levels, tiles: await tiles(o.prefix, `{level}/{row}_{col}.${o.ext}`) });
    }
    return withPreview({ ...ready, layout: "equirect" as const, sources: await Promise.all(o.sources.map(async (src) => ({ width: src.width, url: await urlOf(src) }))) });
  };

  const [scenes, hotspots, floorPlans, assets] = await Promise.all([s.listScenes(tour.id), s.listHotspots(tour.id), s.listFloorPlans(tour.id), s.listAssets(tour.id)]);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const store = rt.files(ctx.env);

  const hotspotView = async (h: (typeof hotspots)[number]): Promise<ManifestHotspot> => {
    const out: ManifestHotspot = { id: h.id, kind: h.kind, position: h.position };
    if (h.targetSceneId) out.targetSceneId = h.targetSceneId;
    if (h.title) out.title = h.title;
    if (h.body) out.bodyHtml = richText(h.body);
    if (h.url) out.url = h.url;
    if (h.mediaKey) out.media = { url: await sign(h.mediaKey), contentType: (await store.head(h.mediaKey))?.contentType ?? null };
    return out;
  };

  return {
    version: 1,
    tour: {
      id: tour.id,
      slug: tour.slug,
      title: tour.title,
      description: tour.description,
      watermark: tour.watermark,
      privacy: tour.privacy,
      startSceneId: tour.startSceneId ?? scenes[0]?.id ?? null,
    },
    scenes: await Promise.all(
      scenes.map(async (sc) => ({
        id: sc.id,
        title: sc.title,
        type: sc.type,
        floor: sc.floor,
        initialView: sc.initialView,
        asset: await assetView(sc.assetId ? assetById.get(sc.assetId) : undefined),
        hotspots: await Promise.all(hotspots.filter((h) => h.sceneId === sc.id).map(hotspotView)),
      })),
    ),
    floorPlans: await Promise.all(floorPlans.map(async (f) => ({ floor: f.floor, title: f.title, image: { url: await sign(f.imageKey) }, markers: f.markers }))),
    analytics: rt.opts.analytics === false ? null : { url: `${origin}${rt.basePath}/${tour.slug}/events${share ? `?share=${encodeURIComponent(share)}` : ""}` },
    live: livePath ? { path: livePath } : null,
    expiresAt: exp,
  };
}
