// Visitor analytics without personal data: the viewer sends a random per-tab session id,
// scene/hotspot ids and dwell times. Raw events are rolled up per day (views, unique sessions,
// average dwell per scene, hotspot clicks) and pruned after `retentionDays`.
import { route, t, validate, type Context, type Env, type RouteDef } from "miujs";
import type { Database } from "@miujs/db";
import { KeyedLimiter } from "@miujs/realtime";
import { loadViewable, viewAccess } from "./access.ts";
import { tourErrors } from "./errors.ts";
import type { TourRuntime } from "./runtime.ts";
import * as S from "./schemas.ts";
import { loadTour } from "./routes/admin.ts";

const MAX_DWELL = 6 * 3600 * 1000;
const MAX_BODY = 32 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const eventsBody = t.object({
  sessionId: t.string({ pattern: /^[A-Za-z0-9_-]{16,64}$/, description: "Random per-tab id made by the viewer (never a user id)" }),
  events: t.array(
    t.object({
      type: t.enum(["view", "scene", "hotspot"]),
      sceneId: t.optional(t.string({ maxLength: 100 })),
      hotspotId: t.optional(t.string({ maxLength: 100 })),
      dwellMs: t.optional(t.integer({ min: 0 })),
    }),
    { min: 1, max: 50 },
  ),
});

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Coarse network prefix (IPv4 /24, IPv6 /48): enough for abuse analysis, not a person. */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) {
    const [head] = ip.split("::");
    const groups = head.split(":").filter(Boolean);
    while (groups.length < 3) groups.push("0");
    return `${groups.slice(0, 3).join(":").toLowerCase()}::/48`;
  }
  return null;
}

export interface AggregateResult {
  /** (tour, day) pairs recomputed. */
  days: number;
  /** Raw events deleted after the retention period. */
  pruned: number;
}

/** Recompute daily rollups from raw events (idempotent), then prune old raw events. */
export async function aggregate(db: Database, opts: { tourId?: string; from?: string; to?: string; now: number; retentionDays?: number; prune?: boolean }): Promise<AggregateResult> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.tourId) {
    where.push("tour_id = ?");
    args.push(opts.tourId);
  }
  if (opts.from) {
    where.push("day >= ?");
    args.push(opts.from);
  }
  if (opts.to) {
    where.push("day <= ?");
    args.push(opts.to);
  }
  const { results: pairs } = await db
    .prepare(`SELECT DISTINCT tour_id, day FROM miu_tour_events${where.length ? " WHERE " + where.join(" AND ") : ""}`)
    .bind(...args)
    .all<{ tour_id: string; day: string }>();
  for (const { tour_id, day } of pairs) {
    await db.batch([
      db.prepare("DELETE FROM miu_tour_daily WHERE tour_id = ? AND day = ?").bind(tour_id, day),
      db.prepare("DELETE FROM miu_tour_daily_scenes WHERE tour_id = ? AND day = ?").bind(tour_id, day),
      db.prepare("DELETE FROM miu_tour_daily_hotspots WHERE tour_id = ? AND day = ?").bind(tour_id, day),
      db
        .prepare(
          `INSERT INTO miu_tour_daily (tour_id, day, views, sessions)
           SELECT tour_id, day, SUM(CASE WHEN type = 'view' THEN 1 ELSE 0 END), COUNT(DISTINCT session_id)
           FROM miu_tour_events WHERE tour_id = ? AND day = ? GROUP BY tour_id, day`,
        )
        .bind(tour_id, day),
      db
        .prepare(
          `INSERT INTO miu_tour_daily_scenes (tour_id, day, scene_id, views, dwell_ms_total, dwell_count)
           SELECT tour_id, day, scene_id, COUNT(*), COALESCE(SUM(dwell_ms), 0), COUNT(dwell_ms)
           FROM miu_tour_events WHERE tour_id = ? AND day = ? AND type = 'scene' AND scene_id IS NOT NULL GROUP BY scene_id`,
        )
        .bind(tour_id, day),
      db
        .prepare(
          `INSERT INTO miu_tour_daily_hotspots (tour_id, day, hotspot_id, clicks)
           SELECT tour_id, day, hotspot_id, COUNT(*)
           FROM miu_tour_events WHERE tour_id = ? AND day = ? AND type = 'hotspot' AND hotspot_id IS NOT NULL GROUP BY hotspot_id`,
        )
        .bind(tour_id, day),
    ]);
  }
  let pruned = 0;
  if (opts.prune !== false) {
    const cutoff = dayOf(opts.now - (opts.retentionDays ?? 30) * 86_400_000);
    const r = await db.prepare(`DELETE FROM miu_tour_events WHERE day < ?${opts.tourId ? " AND tour_id = ?" : ""}`).bind(...(opts.tourId ? [cutoff, opts.tourId] : [cutoff])).run();
    pruned = r.meta.changes;
  }
  return { days: pairs.length, pruned };
}

interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export function analyticsRoutes(rt: TourRuntime): RouteDef[] {
  const opts = rt.opts.analytics === false ? null : (rt.opts.analytics ?? {});
  const perMinute = opts?.perMinute ?? 30;
  const limiter = new KeyedLimiter({ perSecond: perMinute / 60, burst: opts?.burst ?? 10 });
  const retryAfter = Math.max(1, Math.ceil(60 / perMinute));

  const allow = async (ctx: Context, key: string): Promise<boolean> => {
    const binding = opts?.rateLimitBinding ? (ctx.env?.[opts.rateLimitBinding] as RateLimitBinding | undefined) : undefined;
    if (binding && typeof binding.limit === "function") return (await binding.limit({ key })).success;
    return limiter.take(key, rt.now());
  };

  const events = route.post(`${rt.basePath}/:tour/events`, {
    name: "tours_events",
    summary: "Viewer analytics beacon: a random session id plus scene views, dwell times and hotspot clicks (no personal data)",
    tags: ["tours", "csrf-exempt"],
    mcp: false,
    params: S.tourParams,
    query: t.object({ share: t.optional(t.string({ maxLength: 2048 })) }),
    maxBodySize: MAX_BODY,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      if (!opts) throw tourErrors.analyticsDisabled();
      if (!(await allow(ctx, ctx.ip ?? "unknown"))) return tourErrors.rateLimited(retryAfter).toResponse({ "retry-after": String(retryAfter) });
      // No body schema: navigator.sendBeacon(url, string) sends text/plain.
      const text = await ctx.req.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw tourErrors.invalid("The analytics body is not JSON", 'Send {"sessionId": "...", "events": [...]}.');
      }
      const checked = validate(eventsBody, raw);
      if (!checked.ok) {
        throw tourErrors.invalid(`Invalid analytics body: ${checked.issues.slice(0, 3).map((i) => `${i.path} ${i.message}`).join("; ")}`, "Send up to 50 events with a 16-64 character random sessionId.", { issues: checked.issues });
      }
      const body = checked.value;
      const { s, tour } = await loadViewable(rt, ctx, c.params.tour);
      await viewAccess(rt, ctx, s, tour, c.query.share);
      const [scenes, hotspots] = await Promise.all([s.listScenes(tour.id), s.listHotspots(tour.id)]);
      const sceneIds = new Set(scenes.map((x) => x.id));
      const hotspotIds = new Set(hotspots.map((x) => x.id));
      const now = rt.now();
      const day = dayOf(now);
      const ip = tour.privacy === "strict" ? null : ipPrefix(ctx.ip);
      const rows = body.events.filter((e) => {
        if (e.sceneId !== undefined && !sceneIds.has(e.sceneId)) return false;
        if (e.type === "scene" && !e.sceneId) return false;
        if (e.type === "hotspot" && (!e.hotspotId || !hotspotIds.has(e.hotspotId))) return false;
        return true;
      });
      if (rows.length) {
        await s.db.batch(
          rows.map((e) =>
            s.db
              .prepare("INSERT INTO miu_tour_events (tour_id, day, session_id, type, scene_id, hotspot_id, dwell_ms, ip_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(tour.id, day, body.sessionId, e.type, e.sceneId ?? null, e.type === "hotspot" ? e.hotspotId! : null, e.type === "scene" && e.dwellMs !== undefined ? Math.min(e.dwellMs, MAX_DWELL) : null, ip, now),
          ),
        );
      }
      return new Response(null, { status: 204 });
    },
  });

  const stats = route.get(`${rt.basePath}/:tour/stats`, {
    name: "tours_stats",
    summary: "Visitor statistics per day for a tour: views, unique sessions, average dwell per scene and top hotspots",
    tags: ["tours"],
    permission: "tours:read",
    params: S.tourParams,
    query: t.object({
      from: t.optional(t.string({ pattern: DAY_RE, description: "First day, YYYY-MM-DD (UTC). Default: 30 days ago." })),
      to: t.optional(t.string({ pattern: DAY_RE, description: "Last day, YYYY-MM-DD (UTC). Default: today." })),
    }),
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadTour(rt, ctx, c.params.tour);
      const now = rt.now();
      const to = c.query.to ?? dayOf(now);
      const from = c.query.from ?? dayOf(now - 29 * 86_400_000);
      if (from > to) throw tourErrors.invalid("`from` is after `to`", "Pass from <= to, both as YYYY-MM-DD.");
      await aggregate(s.db, { tourId: tour.id, from, to, now, prune: false });
      const db = s.db;
      const [days, sceneRows, hotspotRows, scenes, hotspots] = await Promise.all([
        db.prepare("SELECT day, views, sessions FROM miu_tour_daily WHERE tour_id = ? AND day BETWEEN ? AND ? ORDER BY day").bind(tour.id, from, to).all<{ day: string; views: number; sessions: number }>(),
        db
          .prepare("SELECT scene_id, SUM(views) AS views, SUM(dwell_ms_total) AS dwell, SUM(dwell_count) AS n FROM miu_tour_daily_scenes WHERE tour_id = ? AND day BETWEEN ? AND ? GROUP BY scene_id ORDER BY views DESC, scene_id")
          .bind(tour.id, from, to)
          .all<{ scene_id: string; views: number; dwell: number; n: number }>(),
        db
          .prepare("SELECT hotspot_id, SUM(clicks) AS clicks FROM miu_tour_daily_hotspots WHERE tour_id = ? AND day BETWEEN ? AND ? GROUP BY hotspot_id ORDER BY clicks DESC, hotspot_id LIMIT 10")
          .bind(tour.id, from, to)
          .all<{ hotspot_id: string; clicks: number }>(),
        s.listScenes(tour.id),
        s.listHotspots(tour.id),
      ]);
      const sceneTitle = new Map(scenes.map((x) => [x.id, x.title]));
      const hotspotTitle = new Map(hotspots.map((x) => [x.id, x.title]));
      const dayList = days.results.map((d) => ({ day: d.day, views: Number(d.views), sessions: Number(d.sessions) }));
      return {
        from,
        to,
        totals: { views: dayList.reduce((a, d) => a + d.views, 0), sessions: dayList.reduce((a, d) => a + d.sessions, 0) },
        days: dayList,
        scenes: sceneRows.results.map((r) => ({ sceneId: r.scene_id, title: sceneTitle.get(r.scene_id) ?? null, views: Number(r.views), avgDwellMs: Number(r.n) ? Math.round(Number(r.dwell) / Number(r.n)) : null })),
        hotspots: hotspotRows.results.map((r) => ({ hotspotId: r.hotspot_id, title: hotspotTitle.get(r.hotspot_id) ?? null, clicks: Number(r.clicks) })),
      };
    },
  });

  return [events, stats];
}

/** For the aggregate job and `tourPlugin.aggregate()`. */
export async function aggregateAll(rt: TourRuntime, env: Env, opts: { tourId?: string } = {}): Promise<AggregateResult> {
  const s = await rt.data(env);
  const retentionDays = rt.opts.analytics === false ? undefined : rt.opts.analytics?.retentionDays;
  return aggregate(s.db, { tourId: opts.tourId, now: rt.now(), retentionDays });
}
