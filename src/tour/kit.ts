import { Miu, type Middleware } from "../core/app.ts";
import type { Context } from "../core/context.ts";
import { HttpError, problem } from "../core/errors.ts";
import { t } from "../core/schema.ts";
import { currentUser } from "../batteries/auth/auth.ts";
import { ConflictError, MAX_LIMIT, newId, type Repository } from "../batteries/data/index.ts";
import { imageInfo, isEquirectangular, type BlobStore, type ImageInfo } from "../batteries/files/index.ts";
import { serveBlob } from "../batteries/files/serve.ts";
import { uploadFiles } from "../batteries/files/upload.ts";
import { csrfGuard } from "./csrf.ts";
import { validateTourGraph } from "./graph.ts";
import { assetResponse } from "./assets.ts";
import { editorPage, viewerPage } from "./pages.ts";
import {
  CreateHotspotBody, CreateTourBody, ID_PATTERN, ImportSceneBody, ReorderScenesBody, SLUG_PATTERN, UpdateHotspotBody,
  UpdateSceneBody, UpdateTourBody, slugify, type Hotspot, type Scene, type Tour, type TourView,
} from "./schema.ts";

export interface TourUser {
  id: string | number;
  roles?: string[];
}

export interface TourKitOptions {
  tours: Repository<Tour>;
  scenes: Repository<Scene>;
  hotspots: Repository<Hotspot>;
  /** Where panoramas are stored (memory, local disk, R2, ...). Keys: `tours/<tourId>/<id>.<ext>`. */
  files: BlobStore;
  /** Resolve the signed-in user. Default: `currentUser(c)` from the `auth()` middleware. */
  authorize?: (c: Context<any, any>) => TourUser | undefined | Promise<TourUser | undefined>;
  /** Mount prefix, e.g. "/tours". Routes are registered with it; mount the kit with `app.route("/", kit)`. */
  basePath?: string;
  /** Maximum panorama size in bytes. Default 30 MiB. */
  maxUploadBytes?: number;
  /** Maximum scenes per tour. Default 200. */
  maxScenes?: number;
  /** Maximum hotspots per tour. Default 1000. */
  maxHotspots?: number;
  /** Browsers hitting the editor without a session are redirected here (`?next=` appended). Default: 401. */
  loginPath?: string;
  /** CSP `frame-ancestors` for the public viewer, e.g. "*" to allow embedding anywhere. Default "'self'". */
  frameAncestors?: string;
  /**
   * How long a public tour bundle may be served from this instance's cache (ms, default 5000). Edits made
   * through the kit invalidate it immediately; the TTL only bounds staleness for writes that bypass the kit
   * (e.g. editing scenes in the admin) or happen on another instance. 0 disables the cache.
   */
  bundleCacheMs?: number;
}

export const DEFAULT_VIEW: TourView = { yaw: 0, pitch: 0, fov: 75 };
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const idParam = (description: string) => t.object({ id: t.string({ pattern: ID_PATTERN, description }) });
const TOUR_ID = idParam("Tour id");
const SCENE_ID = idParam("Scene id");
const HOTSPOT_ID = idParam("Hotspot id");
const TAGS = ["tours"];

/**
 * Virtual-tour kit: creator API (tours, scenes with panorama upload, hotspots, publishing), public API
 * (published tour bundle, panorama media), and pages (viewer `/t/:slug`, editor `/editor/:tourId`).
 * All state lives in the given repositories and blob store, so it scales out with their drivers.
 */
export function tourKit(opts: TourKitOptions): Miu {
  const { tours, files } = opts;
  // Scene/hotspot writes go through these wrappers so the owning tour's updatedAt (the public bundle's
  // version) moves and this instance's cached bundle is dropped.
  const bundleCache = new Map<string, { version: string | undefined; at: number; body: string; etag: string }>();
  const bundleCacheMs = opts.bundleCacheMs ?? 5000;
  const touch = async (tourId: string) => {
    bundleCache.delete(tourId);
    await tours.update(tourId, {});
  };
  const scenes = touching(opts.scenes, touch);
  const hotspots = touching(opts.hotspots, touch);
  const base = normalizeBase(opts.basePath);
  const maxBytes = opts.maxUploadBytes ?? DEFAULT_MAX_BYTES;
  const maxScenes = opts.maxScenes ?? 200;
  const maxHotspots = opts.maxHotspots ?? 1000;
  const authorize = opts.authorize ?? ((c: Context<any, any>) => currentUser<TourUser>(c));
  const app = new Miu();
  const p = (path: string) => base + path;

  // ---------- access helpers ----------

  const userOf = async (c: Context<any, any>): Promise<TourUser | undefined> => {
    if (c.get("tourUser") !== undefined) return c.get("tourUser") as TourUser | undefined;
    const u = (await authorize(c)) ?? undefined;
    c.set("tourUser", u ?? null);
    return u;
  };
  const isAdmin = (u: TourUser | undefined) => !!u?.roles?.includes("admin");
  const canEdit = (u: TourUser | undefined, tour: Tour) => !!u && (isAdmin(u) || tour.ownerId === String(u.id));

  const requireUser: Middleware = async (c, next) => {
    if (await userOf(c)) return next();
    if (opts.loginPath && (c.req.headers.get("accept") ?? "").includes("text/html")) {
      const sep = opts.loginPath.includes("?") ? "&" : "?";
      return c.redirect(`${opts.loginPath}${sep}next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
    }
    return problem(401, { code: "unauthenticated", detail: "Sign in (session cookie) or send `Authorization: Bearer <token>` to manage tours." }, { "www-authenticate": "Bearer" });
  };
  const creator = [csrfGuard(), requireUser];
  const user = (c: Context<any, any>) => c.get("tourUser") as TourUser;

  const tourFor = async (c: Context<any, any>, id: string): Promise<Tour> => {
    const tour = await tours.get(id);
    if (!tour) throw new HttpError(404, `No tour ${id}`, { code: "tour_not_found" });
    if (!canEdit(user(c), tour)) throw new HttpError(403, "You can only manage your own tours", { code: "not_owner" });
    return tour;
  };
  const sceneFor = async (c: Context<any, any>, id: string) => {
    const scene = await scenes.get(id);
    if (!scene) throw new HttpError(404, `No scene ${id}`, { code: "scene_not_found" });
    return { scene, tour: await tourFor(c, scene.tourId) };
  };
  const hotspotFor = async (c: Context<any, any>, id: string) => {
    const hotspot = await hotspots.get(id);
    if (!hotspot) throw new HttpError(404, `No hotspot ${id}`, { code: "hotspot_not_found" });
    return { hotspot, tour: await tourFor(c, hotspot.tourId) };
  };

  const scenesOf = async (tourId: string) => (await scenes.list({ where: { tourId }, sort: "order", limit: MAX_LIMIT, count: false })).items;
  const hotspotsOf = async (tourId: string) => (await hotspots.list({ where: { tourId }, sort: "createdAt", limit: MAX_LIMIT, count: false })).items;
  const bySlug = async (slug: string) => (await tours.list({ where: { slug }, limit: 1, count: false })).items[0];

  const slugTaken = (slug: string) => new HttpError(409, `The slug "${slug}" is taken`, { code: "slug_taken" });

  const uniqueSlug = async (wanted: string | undefined, title: string, exceptId?: string): Promise<string> => {
    if (wanted) {
      const other = await bySlug(wanted);
      if (other && other.id !== exceptId) throw slugTaken(wanted);
      return wanted;
    }
    const root = slugify(title);
    if (!(await bySlug(root))) return root;
    for (let i = 0; i < 5; i++) {
      const s = `${root.slice(0, 57).replace(/-+$/, "")}-${randomSuffix()}`;
      if (!(await bySlug(s))) return s;
    }
    throw new HttpError(409, "Could not find a free slug; pass one explicitly", { code: "slug_taken" });
  };

  const assertTarget = async (tourId: string, sceneId: string, target: string | null | undefined) => {
    if (target === undefined || target === null) return;
    if (target === sceneId) throw new HttpError(422, "A link hotspot cannot target its own scene", { code: "invalid_target" });
    const s = await scenes.get(target);
    if (!s || s.tourId !== tourId) throw new HttpError(422, "targetSceneId must be another scene of the same tour", { code: "invalid_target" });
  };

  /** Store a panorama (via `store`, given the key to use) and create its scene; the first scene becomes the start. */
  const addScene = async (
    tour: Tour,
    title: string | undefined,
    view: TourView | undefined,
    store: (keyFor: (ext: string) => string) => Promise<{ key: string; width: number; height: number; fileName?: string }>,
  ) => {
    const existing = await scenesOf(tour.id);
    if (existing.length >= maxScenes) throw new HttpError(422, `A tour can have at most ${maxScenes} scenes`, { code: "limit_reached" });
    const id = newId();
    const stored = await store((ext) => `tours/${tour.id}/${id}.${ext}`);
    const fromFile = stored.fileName?.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 120);
    const scene = await scenes.create({
      id, tourId: tour.id, title: title || fromFile || `Scene ${existing.length + 1}`,
      panoramaKey: stored.key, width: stored.width, height: stored.height,
      initialView: view ?? DEFAULT_VIEW, order: existing.reduce((m, s) => Math.max(m, s.order + 1), 0),
    });
    if (!tour.startSceneId) await tours.update(tour.id, { startSceneId: scene.id });
    return scene;
  };

  const deleteScene = async (tour: Tour, scene: Scene) => {
    const doomed = new Map<string, true>();
    for (const h of await hotspotsOf(tour.id)) if (h.sceneId === scene.id || h.targetSceneId === scene.id) doomed.set(h.id, true);
    for (const id of doomed.keys()) await hotspots.delete(id);
    await scenes.delete(scene.id);
    await files.delete(scene.panoramaKey).catch(() => false);
    const patch: Partial<Tour> = {};
    if (tour.startSceneId === scene.id || tour.coverKey === scene.panoramaKey) {
      const rest = await scenesOf(tour.id);
      if (tour.startSceneId === scene.id) patch.startSceneId = rest[0]?.id;
      if (tour.coverKey === scene.panoramaKey) patch.coverKey = undefined;
      if (!rest.length) patch.status = "draft";
    }
    if (Object.keys(patch).length) await tours.update(tour.id, patch);
  };

  // ---------- creator API ----------

  app.get(p("/api/tours"), {
    operationId: "tour_list", tags: TAGS, use: creator,
    summary: "List my tours",
    description: "List the virtual tours owned by the signed-in creator (admins see every tour), newest first. Supports text search and paging.",
    query: t.object({
      q: t.optional(t.string({ max: 200, description: "Search titles, slugs and descriptions" })),
      limit: t.optional(t.integer({ min: 1, max: 100 })),
      offset: t.optional(t.integer({ min: 0 })),
    }),
  }, async (c) => {
    const u = user(c);
    return tours.list({
      ...(isAdmin(u) ? {} : { where: { ownerId: String(u.id) } }),
      q: c.query.q, limit: c.query.limit ?? 50, offset: c.query.offset, sort: "-createdAt",
    });
  });

  app.post(p("/api/tours"), {
    operationId: "tour_create", tags: TAGS, use: creator, body: CreateTourBody,
    summary: "Create a tour",
    description: "Create a draft virtual tour owned by the caller. The slug (public URL name) defaults to one made from the title. Next: add scenes with scene_import, link them with hotspot_create, then tour_publish.",
  }, async (c) => {
    const { title, slug, description } = c.body;
    const base = { ownerId: String(user(c).id), title, status: "draft", ...(description ? { description } : {}) };
    // uniqueSlug() is a friendly pre-check; { unique: ["slug"] } makes the write itself atomic, so concurrent
    // creates (or other instances) can never both claim a slug. Auto-generated slugs retry with a new suffix.
    for (let attempt = 0; ; attempt++) {
      try {
        const tour = await tours.create(
          { ...base, slug: await uniqueSlug(slug, title) } as Omit<Tour, "id" | "createdAt" | "updatedAt">,
          { unique: ["slug"] },
        );
        return c.json(tour, 201);
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        if (slug || attempt >= 4) throw slugTaken(slug ?? slugify(title));
      }
    }
  });

  app.get(p("/api/tours/:id"), {
    operationId: "tour_get", tags: TAGS, use: creator, params: TOUR_ID,
    summary: "Get a tour with its scenes and hotspots",
    description: "Return { tour, scenes, hotspots } for a tour the caller owns: scenes in display order with panorama keys and initial views, and every hotspot (yaw/pitch in degrees, link targets).",
  }, async (c) => {
    const tour = await tourFor(c, c.params.id);
    return { tour, scenes: await scenesOf(tour.id), hotspots: await hotspotsOf(tour.id) };
  });

  app.patch(p("/api/tours/:id"), {
    operationId: "tour_update", tags: TAGS, use: creator, params: TOUR_ID, body: UpdateTourBody,
    summary: "Update a tour",
    description: "Change a tour's title, slug, description, start scene (startSceneId must be a scene of this tour) or cover (coverKey must be one of its panorama keys).",
  }, async (c) => {
    const tour = await tourFor(c, c.params.id);
    const b = c.body;
    const patch: Partial<Tour> = {};
    if (b.title !== undefined) patch.title = b.title;
    if (b.description !== undefined) patch.description = b.description;
    if (b.slug !== undefined && b.slug !== tour.slug) patch.slug = await uniqueSlug(b.slug, tour.title, tour.id);
    if (b.startSceneId !== undefined) {
      const s = await scenes.get(b.startSceneId);
      if (!s || s.tourId !== tour.id) throw new HttpError(422, "startSceneId must be a scene of this tour", { code: "invalid_start_scene" });
      patch.startSceneId = b.startSceneId;
    }
    if (b.coverKey !== undefined) {
      if (!(await scenesOf(tour.id)).some((s) => s.panoramaKey === b.coverKey)) {
        throw new HttpError(422, "coverKey must be the panorama key of a scene in this tour", { code: "invalid_cover" });
      }
      patch.coverKey = b.coverKey;
    }
    try {
      return await tours.update(tour.id, patch, patch.slug ? { unique: ["slug"] } : {});
    } catch (e) {
      if (e instanceof ConflictError) throw slugTaken(patch.slug!);
      throw e;
    }
  });

  app.delete(p("/api/tours/:id"), {
    operationId: "tour_delete", tags: TAGS, use: creator, params: TOUR_ID,
    summary: "Delete a tour",
    description: "Permanently delete a tour with all of its scenes, hotspots and stored panorama images.",
  }, async (c) => {
    const tour = await tourFor(c, c.params.id);
    for (const h of await hotspotsOf(tour.id)) await hotspots.delete(h.id);
    for (const s of await scenesOf(tour.id)) await scenes.delete(s.id);
    // Remove every stored blob of the tour, including any orphaned by a failed request.
    for (let page = await files.list(`tours/${tour.id}/`); ; page = await files.list(`tours/${tour.id}/`, { cursor: page.cursor })) {
      for (const b of page.items) await files.delete(b.key);
      if (!page.cursor) break;
    }
    await tours.delete(tour.id);
    return undefined;
  });

  const panoramaProblem = (info: { width: number; height: number }) =>
    isEquirectangular(info)
      ? undefined
      : `Panoramas must be equirectangular: a 2:1 image at least 1024 px wide (e.g. 4096x2048 or 8192x4096). This image is ${info.width}x${info.height}. Export the panorama from your 360° camera app as "equirectangular", not a cube map, fisheye or cropped photo.`;

  app.post(p("/api/tours/:id/scenes"), {
    operationId: "scene_upload", tags: TAGS, use: creator, params: TOUR_ID, tool: false,
    summary: "Upload a panorama as a new scene",
    description: `multipart/form-data with a \`panorama\` file (JPEG, PNG or WebP, 2:1 equirectangular, at most ${maxBytes} bytes). Optional query: \`title\` (defaults to the file name). 413 when too large, 415 when not an image, 422 when not 2:1. Agents: use scene_import (JSON + base64).`,
    query: t.object({ title: t.optional(t.string({ min: 1, max: 120 })) }),
  }, async (c) => {
    const tour = await tourFor(c, c.params.id);
    const scene = await addScene(tour, c.query.title, undefined, async (keyFor) => {
      let fileName = "";
      const [f] = await uploadFiles(c, files, {
        field: "panorama", maxBytes, requireImage: true,
        allowed: ["image/jpeg", "image/png", "image/webp"],
        validate: (info) => {
          fileName = info.name;
          return panoramaProblem(info.image!);
        },
        key: (_file, info) => keyFor(info.ext),
      });
      return { key: f!.key, width: f!.width!, height: f!.height!, fileName };
    });
    return c.json(scene, 201);
  });

  const maxJson = Math.ceil(maxBytes * 1.34) + 64 * 1024;
  const limitJson: Middleware = (c, next) => {
    const len = Number(c.req.headers.get("content-length") ?? "0");
    if (len > maxJson) return problem(413, { code: "request_too_large", detail: `Request body exceeds ${maxJson} bytes` });
    return next();
  };

  app.post(p("/api/tours/:id/scenes/import"), {
    operationId: "scene_import", tags: TAGS, use: [...creator, limitJson], params: TOUR_ID, body: ImportSceneBody,
    summary: "Add a scene from a base64 panorama",
    description: "Add a scene to a tour from an equirectangular panorama (JPEG/PNG/WebP, 2:1, at least 1024 px wide) sent as base64 or a data: URL. The first scene becomes the start scene. Returns the scene (id, panoramaKey, width, height, initialView).",
  }, async (c) => {
    const tour = await tourFor(c, c.params.id);
    const bytes = decodeBase64(c.body.panoramaBase64);
    if (!bytes) throw new HttpError(400, "panoramaBase64 is not valid base64", { code: "invalid_base64" });
    if (bytes.byteLength > maxBytes) throw new HttpError(413, `Panorama exceeds ${maxBytes} bytes`, { code: "file_too_large" });
    const info: ImageInfo | undefined = imageInfo(bytes);
    if (!info || info.type === "gif") throw new HttpError(415, "panoramaBase64 is not a JPEG, PNG or WebP image", { code: "file_not_image" });
    const bad = panoramaProblem(info);
    if (bad) throw new HttpError(422, bad, { code: "file_invalid", details: { width: info.width, height: info.height } });
    const ext = info.type === "jpeg" ? "jpg" : info.type;
    const scene = await addScene(tour, c.body.title, c.body.initialView, async (keyOf) => {
      const meta = await files.put(keyOf(ext), bytes, { contentType: info.mime });
      return { key: meta.key, width: info.width, height: info.height };
    });
    return c.json(scene, 201);
  });

  app.patch(p("/api/scenes/:id"), {
    operationId: "scene_update", tags: TAGS, use: creator, params: SCENE_ID, body: UpdateSceneBody,
    summary: "Rename a scene or set its initial view",
    description: "Change a scene's title and/or the camera direction it opens with (initialView: yaw -180..180, pitch -90..90, fov 30..120 degrees).",
  }, async (c) => {
    const { scene } = await sceneFor(c, c.params.id);
    return scenes.update(scene.id, c.body as Partial<Scene>);
  });

  app.delete(p("/api/scenes/:id"), {
    operationId: "scene_delete", tags: TAGS, use: creator, params: SCENE_ID,
    summary: "Delete a scene",
    description: "Delete a scene, its hotspots, link hotspots in other scenes that pointed to it, and its stored panorama. If it was the start scene, the first remaining scene becomes the start.",
  }, async (c) => {
    const { scene, tour } = await sceneFor(c, c.params.id);
    await deleteScene(tour, scene);
    return undefined;
  });

  app.put(p("/api/tours/:id/scene-order"), {
    operationId: "scene_reorder", tags: TAGS, use: creator, params: TOUR_ID, body: ReorderScenesBody,
    summary: "Reorder a tour's scenes",
    description: "Set the display order of scenes. sceneIds must list every scene of the tour exactly once.",
  }, async (c) => {
    const tour = await tourFor(c, c.params.id);
    const current = await scenesOf(tour.id);
    const ids = c.body.sceneIds;
    const known = new Set(current.map((s) => s.id));
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      throw new HttpError(422, "sceneIds must contain every scene of the tour exactly once", { code: "invalid_order", details: { expected: [...known] } });
    }
    const order = new Map(current.map((s) => [s.id, s.order]));
    for (const [i, id] of ids.entries()) if (order.get(id) !== i) await scenes.update(id, { order: i });
    return { scenes: await scenesOf(tour.id) };
  });

  app.post(p("/api/scenes/:id/hotspots"), {
    operationId: "hotspot_create", tags: TAGS, use: creator, params: SCENE_ID, body: CreateHotspotBody,
    summary: "Add a hotspot to a scene",
    description: "Place a hotspot on a scene at yaw/pitch (degrees; yaw 0 = panorama centre, positive = right; pitch positive = up). kind 'link' moves the visitor to targetSceneId (another scene of the same tour); kind 'info' shows title/text/url in a popover.",
  }, async (c) => {
    const { scene, tour } = await sceneFor(c, c.params.id);
    if ((await hotspotsOf(tour.id)).length >= maxHotspots) throw new HttpError(422, `A tour can have at most ${maxHotspots} hotspots`, { code: "limit_reached" });
    await assertTarget(tour.id, scene.id, c.body.targetSceneId);
    const h = await hotspots.create({ ...stripUndefined(c.body), tourId: tour.id, sceneId: scene.id } as Omit<Hotspot, "id">);
    return c.json(h, 201);
  });

  app.patch(p("/api/hotspots/:id"), {
    operationId: "hotspot_update", tags: TAGS, use: creator, params: HOTSPOT_ID, body: UpdateHotspotBody,
    summary: "Move or edit a hotspot",
    description: "Change a hotspot's position (yaw/pitch), kind, target scene, title, text or url. Send null to clear an optional field.",
  }, async (c) => {
    const { hotspot, tour } = await hotspotFor(c, c.params.id);
    await assertTarget(tour.id, hotspot.sceneId, c.body.targetSceneId);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.body)) if (v !== undefined) patch[k] = v === null ? undefined : v;
    return hotspots.update(hotspot.id, patch as Partial<Hotspot>);
  });

  app.delete(p("/api/hotspots/:id"), {
    operationId: "hotspot_delete", tags: TAGS, use: creator, params: HOTSPOT_ID,
    summary: "Delete a hotspot",
    description: "Remove a hotspot from its scene.",
  }, async (c) => {
    const { hotspot } = await hotspotFor(c, c.params.id);
    await hotspots.delete(hotspot.id);
    return undefined;
  });

  app.post(p("/api/tours/:id/publish"), {
    operationId: "tour_publish", tags: TAGS, use: creator, params: TOUR_ID,
    summary: "Publish a tour",
    description: "Validate and publish a tour so it is public at /t/<slug>. Fails with 422 and a `problems` list when the tour has no scenes, no start scene, or a link hotspot without a valid target in the same tour.",
  }, async (c) => {
    const tour = await tourFor(c, c.params.id);
    const problems = validateTourGraph(tour, await scenesOf(tour.id), await hotspotsOf(tour.id));
    if (problems.length) {
      return problem(422, { code: "tour_invalid", detail: `The tour cannot be published yet: ${problems.map((x) => x.message).join(" ")}`, problems });
    }
    return tours.update(tour.id, { status: "published" });
  });

  app.post(p("/api/tours/:id/unpublish"), {
    operationId: "tour_unpublish", tags: TAGS, use: creator, params: TOUR_ID,
    summary: "Unpublish a tour",
    description: "Return a tour to draft: its public page and bundle stop being served, and panorama requests get 404. Panoramas are cached publicly (immutable) while published, so copies already in browser or CDN caches may persist.",
  }, async (c) => tours.update((await tourFor(c, c.params.id)).id, { status: "draft" }));

  // ---------- public API ----------

  const publicBundle = async (tour: Tour) => {
    const { ownerId: _o, ...pub } = tour;
    return {
      tour: pub,
      scenes: (await scenesOf(tour.id)).map(({ createdAt: _c, updatedAt: _u, ...s }) => ({ ...s, panoramaUrl: p(`/media/${s.panoramaKey}`) })),
      hotspots: (await hotspotsOf(tour.id)).map(({ createdAt: _c, updatedAt: _u, ...h }) => h),
    };
  };

  app.get(p("/api/public/tours/:slug"), {
    operationId: "public_tour_get", tags: TAGS,
    params: t.object({ slug: t.string({ pattern: SLUG_PATTERN, description: "Tour slug" }) }),
    summary: "Get a published tour",
    description: "Public: the published tour with its scenes (panoramaUrl, initialView) and hotspots, as shown by the viewer. 404 for drafts. Cacheable (ETag, max-age 60).",
  }, async (c) => {
    const tour = await bySlug(c.params.slug);
    if (!tour || tour.status !== "published") throw new HttpError(404, "No published tour with that slug", { code: "tour_not_found" });
    let hit = bundleCache.get(tour.id);
    if (!hit || hit.version !== tour.updatedAt || Date.now() - hit.at > bundleCacheMs) {
      const body = JSON.stringify(await publicBundle(tour));
      hit = { version: tour.updatedAt, at: Date.now(), body, etag: `"${await shortHash(body)}"` };
      if (bundleCacheMs > 0) {
        if (bundleCache.size >= 500) bundleCache.delete(bundleCache.keys().next().value!);
        bundleCache.set(tour.id, hit);
      }
    }
    const { body, etag } = hit;
    const headers = { etag, "cache-control": "public, max-age=60", vary: "accept-encoding" };
    if (etagMatch(c.req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    return new Response(body, { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  });

  app.get(p("/media/*"), { tool: false, hidden: true, summary: "Panorama image" }, async (c) => {
    const key = (c.params as Record<string, string>)["*"] ?? "";
    const m = /^tours\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.exec(key);
    const notFound = () => problem(404, { detail: "No such panorama" });
    if (!m) return notFound();
    const tour = await tours.get(m[1]!);
    if (!tour) return notFound();
    let cacheControl = "public, max-age=31536000, immutable";
    if (tour.status !== "published") {
      if (!canEdit(await userOf(c), tour)) return notFound();
      cacheControl = "private, max-age=31536000, immutable";
    }
    return serveBlob(c, files, key, { cacheControl });
  });

  // ---------- pages & assets ----------

  app.get(p("/assets/:file"), { tool: false, hidden: true }, (c) => assetResponse(c, c.params.file!));

  app.get(p("/t/:slug"), { tool: false, hidden: true, summary: "Public tour viewer page" }, async (c) => {
    const tour = await bySlug(c.params.slug!);
    const preview = !!tour && tour.status !== "published" && canEdit(await userOf(c), tour);
    if (!tour || (tour.status !== "published" && !preview)) {
      return c.html(`<!doctype html><meta charset="utf-8"><title>Tour not found</title><p>This tour does not exist or is not published.</p>`, 404, { "cache-control": "no-store" });
    }
    return viewerPage(c, { base, bundle: await publicBundle(tour), preview, frameAncestors: opts.frameAncestors ?? "'self'" });
  });

  const html = { tool: false as const, hidden: true, use: [requireUser] };
  app.get(p("/editor"), { ...html, summary: "Tour list (editor)" }, (c) => editorPage(c, { base, tourId: null }));
  app.get(p("/editor/:tourId"), { ...html, summary: "Tour editor page" }, async (c) => {
    const id = c.params.tourId!;
    if (!new RegExp(ID_PATTERN).test(id)) throw new HttpError(404);
    const tour = await tourFor(c, id);
    return editorPage(c, { base, tourId: tour.id, title: tour.title });
  });

  return app;
}

function normalizeBase(b: string | undefined): string {
  if (!b || b === "/") return "";
  const s = b.startsWith("/") ? b : `/${b}`;
  return s.replace(/\/+$/, "");
}

function randomSuffix(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(b, (x) => (x % 36).toString(36)).join("");
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function decodeBase64(s: string): Uint8Array | undefined {
  const raw = s.replace(/^data:[a-z0-9.+/-]*(;[a-z0-9=.+-]+)*;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) return undefined;
  try {
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

async function shortHash(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

function etagMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((v) => {
    const x = v.trim();
    return x === "*" || x.replace(/^W\//, "") === bare;
  });
}

/** Delegating repository that calls `touch(tourId)` after every write, for bundle versioning. */
function touching<T extends { id: string; tourId: string }>(repo: Repository<T>, touch: (tourId: string) => Promise<void>): Repository<T> {
  return {
    list: (q) => repo.list(q),
    get: (id) => repo.get(id),
    async create(data, o) {
      const doc = await repo.create(data, o);
      await touch(doc.tourId);
      return doc;
    },
    async update(id, patch, o) {
      const doc = await repo.update(id, patch, o);
      if (doc) await touch(doc.tourId);
      return doc;
    },
    async delete(id) {
      const doc = await repo.get(id);
      const ok = await repo.delete(id);
      if (ok && doc) await touch(doc.tourId);
      return ok;
    },
  };
}
