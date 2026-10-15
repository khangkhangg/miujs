// Operator view of tours (rendered by @miujs/admin through `Plugin.manage()`): counts of tours,
// scenes, hotspots and assets; a tours list with publish / unpublish, re-queue processing and
// revoking share links. Operators act across every org (these are `system.*` permissions).
// Password hashes, share versions and signing secrets are never shown.

import { t, type Context, type ManageAction, type ManageSection, type ManageValue } from "miujs";
import { tourErrors } from "./errors.ts";
import { STEP_FOR, type TourJobs } from "./jobs.ts";
import type { TourRuntime } from "./runtime.ts";
import type { AssetStatus, Tour, TourStore } from "./store.ts";

const MAX_PAGE = 100;
const STATUSES: AssetStatus[] = ["queued", "processing", "ready", "failed"];

interface QueueLike {
  dispatch(job: unknown, input: unknown): Promise<{ id: string }>;
}

export function tourManage(rt: TourRuntime, jobs: TourJobs): ManageSection[] {
  async function load(ctx: Context, id: unknown): Promise<{ s: TourStore; tour: Tour }> {
    const ref = String(id ?? "");
    const s = await rt.data(ctx.env);
    const tour = ref ? await s.findTour(ref) : null;
    if (!tour) throw tourErrors.notFound(ref);
    return { s, tour };
  }

  const setStatus = (to: "published" | "draft"): ManageAction["run"] =>
    async (input: { id?: unknown }, ctx) => {
      const { s, tour } = await load(ctx, input?.id);
      if (tour.status === to) return to === "published" ? `"${tour.slug}" is already published.` : `"${tour.slug}" is already a draft.`;
      await s.updateTour(tour.id, { status: to });
      return to === "published" ? `Published "${tour.slug}".` : `"${tour.slug}" is now a draft (no longer published).`;
    };

  const rowActions: ManageAction[] = [
    { name: "publish", title: "Publish", description: "Set the tour's status to published.", run: setStatus("published") },
    { name: "unpublish", title: "Unpublish", description: "Set the tour back to draft; viewers lose access.", danger: true, run: setStatus("draft") },
    {
      name: "reprocess",
      title: "Reprocess assets",
      description: "Queue processing (panorama tiles, model optimization) again for this tour's failed assets, or for all of them.",
      input: t.object({ only: t.default(t.enum(["failed", "all"]), "failed") }),
      async run(input: { id?: unknown; only?: "failed" | "all" }, ctx) {
        const { s, tour } = await load(ctx, input?.id);
        const only = input?.only ?? "failed";
        const todo = (await s.listAssets(tour.id)).filter((a) => STEP_FOR[a.kind] && (only === "all" || a.status === "failed"));
        if (!todo.length) return only === "all" ? `No assets of "${tour.slug}" need processing.` : `No assets of "${tour.slug}" failed; nothing to do.`;
        const q = (ctx as unknown as { queue?: QueueLike }).queue;
        if (!q) throw tourErrors.queueMissing();
        const origin = (ctx as unknown as { url?: URL }).url?.origin;
        for (const a of todo) {
          await s.updateAsset(a.id, { status: "queued", progress: 0, error: null });
          await q.dispatch(jobs[STEP_FOR[a.kind]!], origin ? { assetId: a.id, origin } : { assetId: a.id });
        }
        return `Queued ${todo.length} asset${todo.length === 1 ? "" : "s"} of "${tour.slug}" for processing.`;
      },
    },
    {
      name: "revokeShares",
      title: "Revoke share links",
      description: "Invalidate every share link issued for this tour so far.",
      danger: true,
      async run(input: { id?: unknown }, ctx) {
        const { s, tour } = await load(ctx, input?.id);
        await s.revokeShares(tour.id);
        return `Revoked all share links of "${tour.slug}".`;
      },
    },
  ];

  return [
    {
      id: "tours",
      title: "Tours",
      description: "Tours, scenes, hotspots and the asset pipeline.",
      async status(ctx) {
        const db = (await rt.data(ctx.env)).db;
        const tours = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published FROM miu_tours").first<{ n: number; published: number | null }>();
        const scenes = await db.prepare("SELECT COUNT(*) AS n FROM miu_tour_scenes").first<number>("n");
        const hotspots = await db.prepare("SELECT COUNT(*) AS n FROM miu_tour_hotspots").first<number>("n");
        const { results } = await db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM miu_tour_assets GROUP BY status").all<{ status: string; n: number; bytes: number }>();
        const by = new Map(results.map((r) => [r.status, r]));
        const total = results.reduce((acc, r) => acc + Number(r.n), 0);
        const bytes = results.reduce((acc, r) => acc + Number(r.bytes), 0);
        const failed = Number(by.get("failed")?.n ?? 0);
        return {
          stats: [
            { label: "Tours", value: Number(tours?.n ?? 0) },
            { label: "Published", value: Number(tours?.published ?? 0) },
            { label: "Scenes", value: Number(scenes ?? 0) },
            { label: "Hotspots", value: Number(hotspots ?? 0) },
            { label: "Assets", value: total },
            { label: "Failed assets", value: failed, tone: failed > 0 ? "warning" : undefined, hint: "Reprocess them from the tours list." },
            { label: "Source bytes", value: bytes, type: "bytes", hint: "Size of uploaded source files (processed tiles are not counted)." },
          ],
          tables: [
            {
              title: "Assets by status",
              columns: [
                { key: "status", label: "Status" },
                { key: "assets", label: "Assets", type: "number" },
                { key: "bytes", label: "Source size", type: "bytes" },
              ],
              rows: STATUSES.map((st) => ({ status: st, assets: Number(by.get(st)?.n ?? 0), bytes: Number(by.get(st)?.bytes ?? 0) })),
            },
          ],
        };
      },
      lists: [
        {
          name: "tours",
          title: "Tours",
          idKey: "id",
          searchable: true,
          filters: [
            { key: "status", label: "Status", options: ["draft", "published"] },
            { key: "visibility", label: "Visibility", options: ["public", "unlisted", "private"] },
          ],
          columns: [
            { key: "id", label: "Id", type: "code" },
            { key: "slug", label: "Slug", type: "code" },
            { key: "title", label: "Title" },
            { key: "status", label: "Status" },
            { key: "visibility", label: "Visibility" },
            { key: "orgId", label: "Org", type: "code" },
            { key: "scenes", label: "Scenes", type: "number" },
            { key: "failedAssets", label: "Failed assets", type: "number" },
            { key: "hasPassword", label: "Password", type: "boolean" },
            { key: "updatedAt", label: "Updated", type: "date" },
          ],
          async list(q, ctx) {
            const db = (await rt.data(ctx.env)).db;
            const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(q.limit) || MAX_PAGE));
            const offset = /^\d+$/.test(q.cursor ?? "") ? Number(q.cursor) : 0;
            const where: string[] = [];
            const args: unknown[] = [];
            const status = q.filters?.status;
            if (status === "draft" || status === "published") {
              where.push("t.status = ?");
              args.push(status);
            }
            const vis = q.filters?.visibility;
            if (vis === "public" || vis === "unlisted" || vis === "private") {
              where.push("t.visibility = ?");
              args.push(vis);
            }
            const search = q.search?.trim();
            if (search) {
              const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
              where.push("(t.title LIKE ? ESCAPE '\\' OR t.slug LIKE ? ESCAPE '\\' OR t.id = ?)");
              args.push(like, like, search);
            }
            // Only display columns: never password_hash / share_version.
            const sql = `SELECT t.id, t.slug, t.title, t.status, t.visibility, t.org_id, t.updated_at, (t.password_hash IS NOT NULL) AS has_password,
                (SELECT COUNT(*) FROM miu_tour_scenes s WHERE s.tour_id = t.id) AS scenes,
                (SELECT COUNT(*) FROM miu_tour_assets a WHERE a.tour_id = t.id AND a.status = 'failed') AS failed
              FROM miu_tours t${where.length ? " WHERE " + where.join(" AND ") : ""}
              ORDER BY t.created_at DESC, t.id LIMIT ? OFFSET ?`;
            const { results } = await db
              .prepare(sql)
              .bind(...args, limit + 1, offset)
              .all<any>();
            const rows: Record<string, ManageValue>[] = results.slice(0, limit).map((r) => ({
              id: r.id,
              slug: r.slug,
              title: r.title,
              status: r.status,
              visibility: r.visibility,
              orgId: r.org_id ?? null,
              scenes: Number(r.scenes),
              failedAssets: Number(r.failed),
              hasPassword: !!Number(r.has_password),
              updatedAt: Number(r.updated_at),
            }));
            return results.length > limit ? { rows, next: String(offset + limit) } : { rows };
          },
          rowActions,
        },
      ],
    },
  ];
}
