// Data access for tours. Plain SQL over the D1-compatible `Database` from @miujs/db, so the
// same code runs on bun:sqlite locally and on Cloudflare D1.
import type { Database } from "@miujs/db";

export type TourStatus = "draft" | "published";
export type TourVisibility = "public" | "unlisted" | "private";
export type TourPrivacy = "standard" | "strict";
export type SceneType = "pano360" | "model3d" | "image";
export type HotspotKind = "link" | "info" | "media" | "url";
export type AssetKind = "pano" | "model" | "image";
export type AssetStatus = "queued" | "processing" | "ready" | "failed";

export interface Tour {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: TourStatus;
  visibility: TourVisibility;
  orgId: string | null;
  privacy: TourPrivacy;
  watermark: string | null;
  allowedEmbedOrigins: string[];
  startSceneId: string | null;
  hasPassword: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Server-only fields, never returned by routes. */
export interface TourSecrets {
  passwordHash: string | null;
  passwordVersion: number;
  shareVersion: number;
}

export interface View {
  yaw: number;
  pitch: number;
  fov: number;
}

export interface Scene {
  id: string;
  tourId: string;
  title: string;
  type: SceneType;
  assetId: string | null;
  initialView: View;
  floor: number | null;
  order: number;
}

export type HotspotPosition = { yaw: number; pitch: number } | { x: number; y: number; z: number };

export interface Hotspot {
  id: string;
  tourId: string;
  sceneId: string;
  kind: HotspotKind;
  position: HotspotPosition;
  targetSceneId: string | null;
  title: string | null;
  body: string | null;
  mediaKey: string | null;
  url: string | null;
}

export interface FloorPlanMarker {
  sceneId: string;
  /** 0..1 from the left edge of the plan image. */
  x: number;
  /** 0..1 from the top edge. */
  y: number;
}

export interface FloorPlan {
  id: string;
  tourId: string;
  floor: number;
  title: string | null;
  imageKey: string;
  markers: FloorPlanMarker[];
}

export interface Asset {
  id: string;
  tourId: string;
  sceneId: string | null;
  kind: AssetKind;
  sourceKey: string;
  contentType: string;
  size: number;
  status: AssetStatus;
  /** 0..1 */
  progress: number;
  error: string | null;
  /** What the processor produced (PanoramaResult / ModelResult), once ready. */
  output: unknown;
  processor: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface TourInput {
  title: string;
  slug: string;
  description?: string | null;
  status?: TourStatus;
  visibility?: TourVisibility;
  orgId?: string | null;
  privacy?: TourPrivacy;
  watermark?: string | null;
  allowedEmbedOrigins?: string[];
}

export interface TourPatch {
  title?: string;
  slug?: string;
  description?: string | null;
  status?: TourStatus;
  visibility?: TourVisibility;
  privacy?: TourPrivacy;
  watermark?: string | null;
  allowedEmbedOrigins?: string[];
  startSceneId?: string | null;
  passwordHash?: string | null;
}

export interface SceneInput {
  title: string;
  type: SceneType;
  initialView?: Partial<View>;
  floor?: number | null;
  order?: number;
}

export interface HotspotInput {
  kind: HotspotKind;
  position: HotspotPosition;
  targetSceneId?: string | null;
  title?: string | null;
  body?: string | null;
  mediaKey?: string | null;
  url?: string | null;
}

export function randomId(prefix: string, bytes = 10): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = prefix + "_";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toTour(r: any): Tour {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    visibility: r.visibility,
    orgId: r.org_id ?? null,
    privacy: r.privacy,
    watermark: r.watermark ?? null,
    allowedEmbedOrigins: JSON.parse(r.allowed_embed_origins || "[]"),
    startSceneId: r.start_scene_id ?? null,
    hasPassword: !!r.password_hash,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toScene(r: any): Scene {
  return {
    id: r.id,
    tourId: r.tour_id,
    title: r.title,
    type: r.type,
    assetId: r.asset_id ?? null,
    initialView: { yaw: Number(r.yaw), pitch: Number(r.pitch), fov: Number(r.fov) },
    floor: n(r.floor),
    order: Number(r.position),
  };
}

function toHotspot(r: any): Hotspot {
  const position: HotspotPosition = r.x !== null && r.x !== undefined ? { x: Number(r.x), y: Number(r.y), z: Number(r.z) } : { yaw: Number(r.yaw), pitch: Number(r.pitch) };
  return {
    id: r.id,
    tourId: r.tour_id,
    sceneId: r.scene_id,
    kind: r.kind,
    position,
    targetSceneId: r.target_scene_id ?? null,
    title: r.title ?? null,
    body: r.body ?? null,
    mediaKey: r.media_key ?? null,
    url: r.url ?? null,
  };
}

function toAsset(r: any): Asset {
  return {
    id: r.id,
    tourId: r.tour_id,
    sceneId: r.scene_id ?? null,
    kind: r.kind,
    sourceKey: r.source_key,
    contentType: r.content_type,
    size: Number(r.size),
    status: r.status,
    progress: Number(r.progress),
    error: r.error ?? null,
    output: r.output ? JSON.parse(r.output) : null,
    processor: r.processor ?? null,
    attempts: Number(r.attempts),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function isXyz(p: HotspotPosition): p is { x: number; y: number; z: number } {
  return "x" in p;
}

export class TourStore {
  readonly db: Database;
  private now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  // ---- tours ----

  async createTour(input: TourInput): Promise<Tour> {
    const id = randomId("tour");
    const t = this.now();
    await this.db
      .prepare(
        `INSERT INTO miu_tours (id, slug, title, description, status, visibility, org_id, privacy, watermark, allowed_embed_origins, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.slug,
        input.title,
        input.description ?? null,
        input.status ?? "draft",
        input.visibility ?? "private",
        input.orgId ?? null,
        input.privacy ?? "standard",
        input.watermark ?? null,
        JSON.stringify(input.allowedEmbedOrigins ?? []),
        t,
        t,
      )
      .run();
    return (await this.findTour(id))!;
  }

  /**
   * By id or slug. `orgId`: a string = only that org's tours, `null` = only tours without an
   * org, `undefined` = no tenant filter (apps without multi-tenancy).
   */
  async findTour(ref: string, orgId?: string | null): Promise<Tour | null> {
    const row = await this.tourRow(ref, orgId);
    return row ? toTour(row) : null;
  }

  async tourSecrets(id: string): Promise<TourSecrets | null> {
    const r = await this.db.prepare("SELECT password_hash, password_version, share_version FROM miu_tours WHERE id = ?").bind(id).first<any>();
    return r ? { passwordHash: r.password_hash ?? null, passwordVersion: Number(r.password_version), shareVersion: Number(r.share_version) } : null;
  }

  private tourRow(ref: string, orgId?: string | null): Promise<any> {
    const col = ref.startsWith("tour_") ? "id" : "slug";
    if (typeof orgId === "string") return this.db.prepare(`SELECT * FROM miu_tours WHERE ${col} = ? AND org_id = ?`).bind(ref, orgId).first();
    if (orgId === null) return this.db.prepare(`SELECT * FROM miu_tours WHERE ${col} = ? AND org_id IS NULL`).bind(ref).first();
    return this.db.prepare(`SELECT * FROM miu_tours WHERE ${col} = ?`).bind(ref).first();
  }

  async slugTaken(slug: string, exceptId?: string): Promise<boolean> {
    const r = await this.db.prepare("SELECT id FROM miu_tours WHERE slug = ?").bind(slug).first<{ id: string }>();
    return !!r && r.id !== exceptId;
  }

  async listTours(opts: { orgId?: string | null; status?: TourStatus; visibility?: TourVisibility; limit?: number; offset?: number }): Promise<Tour[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (typeof opts.orgId === "string") {
      where.push("org_id = ?");
      args.push(opts.orgId);
    } else if (opts.orgId === null) {
      where.push("org_id IS NULL");
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.visibility) {
      where.push("visibility = ?");
      args.push(opts.visibility);
    }
    const sql = `SELECT * FROM miu_tours${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`;
    const { results } = await this.db
      .prepare(sql)
      .bind(...args, opts.limit ?? 50, opts.offset ?? 0)
      .all();
    return results.map(toTour);
  }

  async updateTour(id: string, patch: TourPatch): Promise<Tour> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.slug !== undefined) set("slug", patch.slug);
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.visibility !== undefined) set("visibility", patch.visibility);
    if (patch.privacy !== undefined) set("privacy", patch.privacy);
    if (patch.watermark !== undefined) set("watermark", patch.watermark);
    if (patch.allowedEmbedOrigins !== undefined) set("allowed_embed_origins", JSON.stringify(patch.allowedEmbedOrigins));
    if (patch.startSceneId !== undefined) set("start_scene_id", patch.startSceneId);
    if (patch.passwordHash !== undefined) {
      set("password_hash", patch.passwordHash);
      sets.push("password_version = password_version + 1");
    }
    set("updated_at", this.now());
    await this.db
      .prepare(`UPDATE miu_tours SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...args, id)
      .run();
    return (await this.findTour(id))!;
  }

  /** Invalidates every share link issued so far. */
  async revokeShares(id: string): Promise<void> {
    await this.db.prepare("UPDATE miu_tours SET share_version = share_version + 1, updated_at = ? WHERE id = ?").bind(this.now(), id).run();
  }

  async deleteTour(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM miu_tours WHERE id = ?").bind(id).run();
  }

  // ---- scenes ----

  async createScene(tourId: string, input: SceneInput): Promise<Scene> {
    const id = randomId("scn");
    const t = this.now();
    let order = input.order;
    if (order === undefined) {
      const max = await this.db.prepare("SELECT MAX(position) AS m FROM miu_tour_scenes WHERE tour_id = ?").bind(tourId).first<number | null>("m");
      order = max === null || max === undefined ? 0 : Number(max) + 1;
    }
    const v = input.initialView ?? {};
    await this.db
      .prepare(
        `INSERT INTO miu_tour_scenes (id, tour_id, title, type, yaw, pitch, fov, floor, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, tourId, input.title, input.type, v.yaw ?? 0, v.pitch ?? 0, v.fov ?? 75, input.floor ?? null, order, t, t)
      .run();
    return (await this.getScene(tourId, id))!;
  }

  async getScene(tourId: string, id: string): Promise<Scene | null> {
    const r = await this.db.prepare("SELECT * FROM miu_tour_scenes WHERE tour_id = ? AND id = ?").bind(tourId, id).first();
    return r ? toScene(r) : null;
  }

  async listScenes(tourId: string): Promise<Scene[]> {
    const { results } = await this.db.prepare("SELECT * FROM miu_tour_scenes WHERE tour_id = ? ORDER BY position, created_at, id").bind(tourId).all();
    return results.map(toScene);
  }

  async updateScene(tourId: string, id: string, patch: { title?: string; initialView?: Partial<View>; floor?: number | null; order?: number }): Promise<Scene> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.initialView?.yaw !== undefined) set("yaw", patch.initialView.yaw);
    if (patch.initialView?.pitch !== undefined) set("pitch", patch.initialView.pitch);
    if (patch.initialView?.fov !== undefined) set("fov", patch.initialView.fov);
    if (patch.floor !== undefined) set("floor", patch.floor);
    if (patch.order !== undefined) set("position", patch.order);
    set("updated_at", this.now());
    await this.db
      .prepare(`UPDATE miu_tour_scenes SET ${sets.join(", ")} WHERE tour_id = ? AND id = ?`)
      .bind(...args, tourId, id)
      .run();
    return (await this.getScene(tourId, id))!;
  }

  async setSceneAsset(tourId: string, sceneId: string, assetId: string | null): Promise<void> {
    await this.db.prepare("UPDATE miu_tour_scenes SET asset_id = ?, updated_at = ? WHERE tour_id = ? AND id = ?").bind(assetId, this.now(), tourId, sceneId).run();
  }

  async deleteScene(tourId: string, id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE miu_tours SET start_scene_id = NULL WHERE id = ? AND start_scene_id = ?").bind(tourId, id),
      this.db.prepare("DELETE FROM miu_tour_scenes WHERE tour_id = ? AND id = ?").bind(tourId, id),
    ]);
  }

  // ---- hotspots ----

  async createHotspot(tourId: string, sceneId: string, input: HotspotInput): Promise<Hotspot> {
    const id = randomId("hs");
    const p = input.position;
    const xyz = isXyz(p);
    await this.db
      .prepare(
        `INSERT INTO miu_tour_hotspots (id, tour_id, scene_id, kind, yaw, pitch, x, y, z, target_scene_id, title, body, media_key, url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        tourId,
        sceneId,
        input.kind,
        xyz ? null : p.yaw,
        xyz ? null : p.pitch,
        xyz ? p.x : null,
        xyz ? p.y : null,
        xyz ? p.z : null,
        input.targetSceneId ?? null,
        input.title ?? null,
        input.body ?? null,
        input.mediaKey ?? null,
        input.url ?? null,
        this.now(),
      )
      .run();
    return (await this.getHotspot(tourId, id))!;
  }

  async getHotspot(tourId: string, id: string): Promise<Hotspot | null> {
    const r = await this.db.prepare("SELECT * FROM miu_tour_hotspots WHERE tour_id = ? AND id = ?").bind(tourId, id).first();
    return r ? toHotspot(r) : null;
  }

  async listHotspots(tourId: string): Promise<Hotspot[]> {
    const { results } = await this.db.prepare("SELECT * FROM miu_tour_hotspots WHERE tour_id = ? ORDER BY created_at, id").bind(tourId).all();
    return results.map(toHotspot);
  }

  /** Replaces the hotspot's fields with `next` (a full, validated hotspot). */
  async replaceHotspot(tourId: string, id: string, next: HotspotInput): Promise<Hotspot> {
    const p = next.position;
    const xyz = isXyz(p);
    await this.db
      .prepare(
        `UPDATE miu_tour_hotspots SET kind = ?, yaw = ?, pitch = ?, x = ?, y = ?, z = ?, target_scene_id = ?, title = ?, body = ?, media_key = ?, url = ?
         WHERE tour_id = ? AND id = ?`,
      )
      .bind(
        next.kind,
        xyz ? null : p.yaw,
        xyz ? null : p.pitch,
        xyz ? p.x : null,
        xyz ? p.y : null,
        xyz ? p.z : null,
        next.targetSceneId ?? null,
        next.title ?? null,
        next.body ?? null,
        next.mediaKey ?? null,
        next.url ?? null,
        tourId,
        id,
      )
      .run();
    return (await this.getHotspot(tourId, id))!;
  }

  async deleteHotspot(tourId: string, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM miu_tour_hotspots WHERE tour_id = ? AND id = ?").bind(tourId, id).run();
  }

  // ---- floor plans ----

  async putFloorPlan(tourId: string, floor: number, input: { title?: string | null; imageKey: string; markers: FloorPlanMarker[] }): Promise<FloorPlan> {
    const existing = await this.db.prepare("SELECT id FROM miu_tour_floorplans WHERE tour_id = ? AND floor = ?").bind(tourId, floor).first<{ id: string }>();
    const id = existing?.id ?? randomId("fp");
    const stmts = [
      existing
        ? this.db.prepare("UPDATE miu_tour_floorplans SET title = ?, image_key = ? WHERE id = ?").bind(input.title ?? null, input.imageKey, id)
        : this.db.prepare("INSERT INTO miu_tour_floorplans (id, tour_id, floor, title, image_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, tourId, floor, input.title ?? null, input.imageKey, this.now()),
      this.db.prepare("DELETE FROM miu_tour_floorplan_markers WHERE floorplan_id = ?").bind(id),
      ...input.markers.map((m) => this.db.prepare("INSERT INTO miu_tour_floorplan_markers (floorplan_id, scene_id, x, y) VALUES (?, ?, ?, ?)").bind(id, m.sceneId, m.x, m.y)),
    ];
    await this.db.batch(stmts);
    return (await this.listFloorPlans(tourId)).find((f) => f.id === id)!;
  }

  async listFloorPlans(tourId: string): Promise<FloorPlan[]> {
    const { results: plans } = await this.db.prepare("SELECT * FROM miu_tour_floorplans WHERE tour_id = ? ORDER BY floor").bind(tourId).all<any>();
    if (!plans.length) return [];
    const { results: markers } = await this.db
      .prepare(
        `SELECT m.floorplan_id, m.scene_id, m.x, m.y FROM miu_tour_floorplan_markers m
         JOIN miu_tour_floorplans f ON f.id = m.floorplan_id WHERE f.tour_id = ? ORDER BY m.rowid`,
      )
      .bind(tourId)
      .all<any>();
    return plans.map((p) => ({
      id: p.id,
      tourId: p.tour_id,
      floor: Number(p.floor),
      title: p.title ?? null,
      imageKey: p.image_key,
      markers: markers.filter((m) => m.floorplan_id === p.id).map((m) => ({ sceneId: m.scene_id, x: Number(m.x), y: Number(m.y) })),
    }));
  }

  async deleteFloorPlan(tourId: string, floor: number): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM miu_tour_floorplans WHERE tour_id = ? AND floor = ?").bind(tourId, floor).run();
    return r.meta.changes > 0;
  }

  // ---- assets ----

  /** Records a source file for a scene and points the scene at it. */
  async createAsset(input: { tourId: string; sceneId: string | null; kind: AssetKind; sourceKey: string; contentType: string; size: number; status?: AssetStatus }): Promise<Asset> {
    const id = randomId("ast");
    const t = this.now();
    const stmts = [
      this.db
        .prepare(
          `INSERT INTO miu_tour_assets (id, tour_id, scene_id, kind, source_key, content_type, size, status, progress, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, input.tourId, input.sceneId, input.kind, input.sourceKey, input.contentType, input.size, input.status ?? "queued", input.status === "ready" ? 1 : 0, t, t),
    ];
    if (input.sceneId) stmts.push(this.db.prepare("UPDATE miu_tour_scenes SET asset_id = ?, updated_at = ? WHERE tour_id = ? AND id = ?").bind(id, t, input.tourId, input.sceneId));
    await this.db.batch(stmts);
    return (await this.getAsset(id))!;
  }

  async getAsset(id: string): Promise<Asset | null> {
    const r = await this.db.prepare("SELECT * FROM miu_tour_assets WHERE id = ?").bind(id).first();
    return r ? toAsset(r) : null;
  }

  async listAssets(tourId: string): Promise<Asset[]> {
    const { results } = await this.db.prepare("SELECT * FROM miu_tour_assets WHERE tour_id = ? ORDER BY created_at, id").bind(tourId).all();
    return results.map(toAsset);
  }

  async updateAsset(id: string, patch: { status?: AssetStatus; progress?: number; error?: string | null; output?: unknown; processor?: string | null; attempts?: number }): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.progress !== undefined) set("progress", Math.max(0, Math.min(1, patch.progress)));
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.output !== undefined) set("output", patch.output === null ? null : JSON.stringify(patch.output));
    if (patch.processor !== undefined) set("processor", patch.processor);
    if (patch.attempts !== undefined) set("attempts", patch.attempts);
    set("updated_at", this.now());
    await this.db
      .prepare(`UPDATE miu_tour_assets SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...args, id)
      .run();
  }
}
