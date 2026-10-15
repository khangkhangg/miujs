import { t } from "miujs";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `'self'`, or a scheme + host (+ port) with an optional leading `*.` wildcard. Nothing else gets into CSP. */
export const EMBED_ORIGIN_RE = /^(?:'self'|https?:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?)$/;

export const slug = t.string({ pattern: SLUG_RE, maxLength: 80, description: "lowercase-words-with-dashes", example: "12-elm-street" });
export const yaw = t.number({ min: -180, max: 180, description: "Degrees, 0 = panorama centre, positive = right" });
export const pitch = t.number({ min: -90, max: 90, description: "Degrees, positive = up" });
export const fov = t.number({ min: 10, max: 120, description: "Field of view in degrees" });

export const status = t.enum(["draft", "published"]);
export const visibility = t.enum(["public", "unlisted", "private"]);
export const privacy = t.enum(["standard", "strict"]);
export const sceneType = t.enum(["pano360", "model3d", "image"]);
export const hotspotKind = t.enum(["link", "info", "media", "url"]);

export const embedOrigins = t.array(t.string({ pattern: EMBED_ORIGIN_RE, maxLength: 200 }), { max: 20 });

export const tourParams = t.object({ tour: t.string({ maxLength: 100 }) });
export const sceneParams = t.object({ tour: t.string({ maxLength: 100 }), scene: t.string({ maxLength: 100 }) });
export const hotspotParams = t.object({ tour: t.string({ maxLength: 100 }), hotspot: t.string({ maxLength: 100 }) });
export const floorParams = t.object({ tour: t.string({ maxLength: 100 }), floor: t.integer({ min: -20, max: 200 }) });
export const assetParams = t.object({ tour: t.string({ maxLength: 100 }), asset: t.string({ maxLength: 100 }) });

export const createTourBody = t.object({
  title: t.string({ minLength: 1, maxLength: 200 }),
  slug,
  description: t.optional(t.nullable(t.string({ maxLength: 5000 }))),
  status: t.optional(status),
  visibility: t.optional(visibility),
  privacy: t.optional(privacy),
  watermark: t.optional(t.nullable(t.string({ maxLength: 120 }))),
  allowedEmbedOrigins: t.optional(embedOrigins),
});

export const updateTourBody = t.object({
  title: t.optional(t.string({ minLength: 1, maxLength: 200 })),
  slug: t.optional(slug),
  description: t.optional(t.nullable(t.string({ maxLength: 5000 }))),
  status: t.optional(status),
  visibility: t.optional(visibility),
  privacy: t.optional(privacy),
  watermark: t.optional(t.nullable(t.string({ maxLength: 120 }))),
  allowedEmbedOrigins: t.optional(embedOrigins),
  startSceneId: t.optional(t.nullable(t.string({ maxLength: 100 }))),
  password: t.optional(t.nullable(t.string({ minLength: 6, maxLength: 200, description: "Viewers must enter it; null removes it" }))),
});

const view = t.object({ yaw: t.optional(yaw), pitch: t.optional(pitch), fov: t.optional(fov) });

export const createSceneBody = t.object({
  title: t.string({ minLength: 1, maxLength: 200 }),
  type: sceneType,
  initialView: t.optional(view),
  floor: t.optional(t.nullable(t.integer({ min: -20, max: 200 }))),
  order: t.optional(t.integer({ min: 0, max: 100000 })),
});

export const updateSceneBody = t.object({
  title: t.optional(t.string({ minLength: 1, maxLength: 200 })),
  initialView: t.optional(view),
  floor: t.optional(t.nullable(t.integer({ min: -20, max: 200 }))),
  order: t.optional(t.integer({ min: 0, max: 100000 })),
});

const coord = t.number({ min: -1e6, max: 1e6 });
export const position = t.union([
  t.object({ yaw, pitch }, { description: "On a 360° panorama" }),
  t.object({ x: coord, y: coord, z: t.default(coord, 0) }, { description: "On a 3D model (model units), or on an image scene (x, y from 0 to 1)" }),
]);

export const createHotspotBody = t.object({
  kind: hotspotKind,
  position,
  targetSceneId: t.optional(t.nullable(t.string({ maxLength: 100 }))),
  title: t.optional(t.nullable(t.string({ maxLength: 200 }))),
  body: t.optional(t.nullable(t.string({ maxLength: 10000, description: "Paragraphs, **bold**, *emphasis*, [links](https://...)" }))),
  mediaKey: t.optional(t.nullable(t.string({ maxLength: 1024 }))),
  url: t.optional(t.nullable(t.string({ format: "url", maxLength: 2000 }))),
});

export const updateHotspotBody = t.object({
  kind: t.optional(hotspotKind),
  position: t.optional(position),
  targetSceneId: t.optional(t.nullable(t.string({ maxLength: 100 }))),
  title: t.optional(t.nullable(t.string({ maxLength: 200 }))),
  body: t.optional(t.nullable(t.string({ maxLength: 10000 }))),
  mediaKey: t.optional(t.nullable(t.string({ maxLength: 1024 }))),
  url: t.optional(t.nullable(t.string({ format: "url", maxLength: 2000 }))),
});

export const floorPlanBody = t.object({
  title: t.optional(t.nullable(t.string({ maxLength: 200 }))),
  imageKey: t.string({ maxLength: 1024, description: "File key of the plan image (upload it with @miujs/files first)" }),
  markers: t.array(t.object({ sceneId: t.string({ maxLength: 100 }), x: t.number({ min: 0, max: 1 }), y: t.number({ min: 0, max: 1 }) }), { max: 500 }),
});

export const listQuery = t.object({
  status: t.optional(status),
  visibility: t.optional(visibility),
  limit: t.optional(t.integer({ min: 1, max: 200 })),
  offset: t.optional(t.integer({ min: 0 })),
});
