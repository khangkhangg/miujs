import { t, type Infer } from "../core/schema.ts";

/**
 * Virtual-tour data model. A Tour owns ordered Scenes (one equirectangular panorama each); Hotspots sit on a
 * scene at a yaw/pitch and either link to another scene of the same tour or show information.
 * `Hotspot.tourId` is denormalised so a tour's hotspots load in one query and ownership checks need no join.
 */

/** Lowercase letters, digits and single dashes inside; 1-64 characters. */
export const SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";
/** Ids from `newId()` (base64url) or user-chosen ids of the same alphabet. */
export const ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$";

const id = (description?: string) => t.string({ pattern: ID_PATTERN, ...(description ? { description } : {}) });
const title = (description: string) => t.string({ min: 1, max: 120, description });

export const yaw = t.number({ min: -180, max: 180, description: "Horizontal angle in degrees; 0 = centre of the panorama, positive = right" });
export const pitch = t.number({ min: -90, max: 90, description: "Vertical angle in degrees; 0 = horizon, positive = up" });
export const fov = t.number({ min: 30, max: 120, description: "Vertical field of view in degrees" });

export const ViewSchema = t.object({ yaw, pitch, fov }, { description: "Camera direction and zoom" });

export const TourStatus = t.enum(["draft", "published"] as const);

export const TourSchema = t.object({
  id: id(),
  ownerId: t.string({ min: 1, max: 128 }),
  title: title("Tour title"),
  slug: t.string({ pattern: SLUG_PATTERN, description: "Unique, URL-safe name used in public links (/t/<slug>)" }),
  description: t.optional(t.string({ max: 2000 })),
  status: TourStatus,
  startSceneId: t.optional(id("Scene shown first")),
  coverKey: t.optional(t.string({ max: 1024 })),
  createdAt: t.string({ format: "date-time" }),
  updatedAt: t.string({ format: "date-time" }),
});

export const SceneSchema = t.object({
  id: id(),
  tourId: id(),
  title: title("Scene title"),
  panoramaKey: t.string({ min: 1, max: 1024, description: "Blob key of the equirectangular panorama" }),
  width: t.integer({ min: 1 }),
  height: t.integer({ min: 1 }),
  initialView: ViewSchema,
  order: t.integer({ min: 0 }),
  createdAt: t.optional(t.string()),
  updatedAt: t.optional(t.string()),
});

export const HotspotKind = t.enum(["link", "info"] as const, { description: "link = go to another scene; info = show a popover" });

const hotspotFields = {
  kind: HotspotKind,
  yaw,
  pitch,
  targetSceneId: t.optional(id("For link hotspots: the scene to open (same tour)")),
  title: t.optional(t.string({ max: 120, description: "Label / popover heading" })),
  text: t.optional(t.string({ max: 2000, description: "Popover body (plain text)" })),
  url: t.optional(t.string({ format: "url", max: 2000, description: "Optional http(s) link shown in the popover" })),
};

export const HotspotSchema = t.object({
  id: id(),
  tourId: id(),
  sceneId: id(),
  ...hotspotFields,
  createdAt: t.optional(t.string()),
  updatedAt: t.optional(t.string()),
});

export type TourView = Infer<typeof ViewSchema>;
export type Tour = Infer<typeof TourSchema>;
export type Scene = Infer<typeof SceneSchema>;
export type Hotspot = Infer<typeof HotspotSchema>;

// ---------- request bodies ----------

export const CreateTourBody = t.object({
  title: title("Tour title"),
  slug: t.optional(t.string({ pattern: SLUG_PATTERN, description: "Defaults to a slug made from the title" })),
  description: t.optional(t.string({ max: 2000 })),
});

export const UpdateTourBody = t.object({
  title: t.optional(title("Tour title")),
  slug: t.optional(t.string({ pattern: SLUG_PATTERN })),
  description: t.optional(t.string({ max: 2000 })),
  startSceneId: t.optional(id("Scene shown first; must belong to this tour")),
  coverKey: t.optional(t.string({ max: 1024, description: "Panorama key of one of this tour's scenes" })),
});

export const ImportSceneBody = t.object({
  title: title("Scene title"),
  panoramaBase64: t.string({ min: 1, description: "The equirectangular image (JPEG/PNG/WebP, 2:1) as base64 (data: URL prefix allowed)" }),
  initialView: t.optional(ViewSchema),
});

export const UpdateSceneBody = t.object({
  title: t.optional(title("Scene title")),
  initialView: t.optional(ViewSchema),
});

export const ReorderScenesBody = t.object({
  sceneIds: t.array(id(), { min: 1, max: 1000, description: "Every scene id of the tour, in the new order" }),
});

export const CreateHotspotBody = t.object(hotspotFields);

export const UpdateHotspotBody = t.object({
  kind: t.optional(HotspotKind),
  yaw: t.optional(yaw),
  pitch: t.optional(pitch),
  targetSceneId: t.optional(t.nullable(id("Scene to open; null clears it"))),
  title: t.optional(t.nullable(t.string({ max: 120 }))),
  text: t.optional(t.nullable(t.string({ max: 2000 }))),
  url: t.optional(t.nullable(t.string({ format: "url", max: 2000 }))),
});

/** A URL-safe slug from free text: ASCII-folded, lowercase, dash-separated, at most 64 characters. */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return s || "tour";
}
