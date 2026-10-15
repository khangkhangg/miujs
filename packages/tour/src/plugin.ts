import { definePlugin, processEnv, targetRuntime, type App, type CloudflareNeeds, type Env } from "miujs";
import { describeDatabase } from "@miujs/db";
import { aggregateAll, analyticsRoutes } from "./analytics.ts";
import { tourErrors } from "./errors.ts";
import { createJobs } from "./jobs.ts";
import { tourManage } from "./manage.ts";
import { adminRoutes } from "./routes/admin.ts";
import { assetRoutes } from "./routes/assets.ts";
import { liveRoutes } from "./live.ts";
import { processorRoutes } from "./processors/external.ts";
import { pageRoutes } from "./routes/page.ts";
import { viewerRoutes } from "./routes/viewer.ts";
import { createRuntime, type TourOptions } from "./runtime.ts";
import { VIEWER_VERSIONS } from "./viewer-assets.ts";

const PROCESSING_NOTE =
  "Asset processing runs in queue jobs. Cloudflare Workers have tight CPU and memory limits, so tiling panoramas and compressing models cannot run inside a Worker: use externalProcessor() (your container/server) or cloudflareImagesProcessor() there; vipsProcessor() and gltfTransformProcessor() need a Bun/Node host with the tools installed.";

/** The app's queue plugin (`queue()` from @miujs/queue), if any. */
function queuePlugin(app: App): { hasJob(name: string): boolean } | null {
  const q = app.plugins.find((p) => p.name === "queue") as { hasJob?: (name: string) => boolean } | undefined;
  return q && typeof q.hasJob === "function" ? (q as { hasJob(name: string): boolean }) : null;
}

/**
 * 3D and 360° virtual tours: data model and editor API, an asset pipeline on queue jobs,
 * signed viewer manifests, an embeddable viewer page, live guided tours and analytics.
 *
 * ```ts
 * const store = r2Store("FILES");
 * const tours = tour({ store, processors: [externalProcessor({ url, secret })] });
 * miu({ plugins: [auth(), access({ roles }), files({ store }), queue({ jobs: tours.jobs.all }), tours] });
 * ```
 */
export function tour(opts: TourOptions = {}) {
  const rt = createRuntime(opts);
  const jobs = createJobs(rt);
  const routes = [...adminRoutes(rt), ...assetRoutes(rt, jobs), ...viewerRoutes(rt), ...pageRoutes(rt), ...liveRoutes(rt), ...analyticsRoutes(rt), ...processorRoutes(rt)];
  return definePlugin({
    name: "tour",
    routes,
    /** Queue jobs to register: `queue({ jobs: [...tours.jobs.all] })`. */
    jobs,
    /** Roll up analytics now (also what the aggregateStats job does). Outside requests, env defaults to the process env. */
    aggregate: (o: { env?: Env; tourId?: string } = {}) => aggregateAll(rt, o.env ?? processEnv(), o),
    setup(app: App) {
      rt.dev = app.dev;
      rt.log = app.log.child({ plugin: "tour" });
      if (app.hasService("files")) rt.filesService = app.service("files");
      if (targetRuntime() === "workerd") {
        const local = rt.processors.find((x) => x.needsProcess);
        if (local) throw tourErrors.processorUnavailable(local.name, "a local program", "Cloudflare Workers cannot spawn programs. Use externalProcessor() (a container or server you run) or cloudflareImagesProcessor() in the Worker, and run vipsProcessor()/gltfTransformProcessor() inside that service.");
      }
      const q = queuePlugin(app);
      if (q) {
        const missing = jobs.all.map((j) => j.name).filter((n) => !q.hasJob(n));
        if (missing.length) throw tourErrors.jobsNotRegistered(missing);
      }
    },
    inspect() {
      const a = opts.analytics;
      return {
        basePath: rt.basePath,
        database: describeDatabase(rt.source()),
        store: opts.store ? { kind: opts.store.kind, ...opts.store.inspect?.() } : rt.filesService ? "files plugin" : { kind: "memory" },
        secret: opts.secret ? "(option)" : "env.TOUR_SECRET, FILES_SECRET or SESSION_SECRET",
        processors: rt.processors.map((x) => ({
          name: x.name,
          steps: (["tilePanorama", "optimizeModel"] as const).filter((s) => typeof x[s] === "function"),
          ...x.inspect?.(),
        })),
        processing: PROCESSING_NOTE,
        jobs: jobs.all.map((j) => j.name),
        viewer: { assets: opts.viewerAssets ?? "cdn", versions: VIEWER_VERSIONS },
        analytics: a === false ? false : { perMinute: a?.perMinute ?? 30, burst: a?.burst ?? 10, retentionDays: a?.retentionDays ?? 30, ...(a?.rateLimitBinding ? { rateLimitBinding: a.rateLimitBinding } : {}) },
        live: !!opts.live,
      };
    },
    /** Operator view for @miujs/admin: counts, tours list, publish / unpublish, reprocess, revoke shares. */
    manage: () => tourManage(rt, jobs),
    cloudflare(): CloudflareNeeds {
      const needs: CloudflareNeeds = {};
      const db = describeDatabase(rt.source());
      if (db.adapter === "d1" && typeof db.binding === "string") needs.d1 = [db.binding];
      const st = opts.store;
      const r2 = st?.forEnv && st.kind === "r2" ? st.inspect?.().binding : undefined;
      if (typeof r2 === "string") needs.r2 = [r2];
      const a = opts.analytics;
      if (a && a.rateLimitBinding) needs.ratelimits = [{ binding: a.rateLimitBinding, limit: a.perMinute ?? 30, period: 60 }];
      return needs;
    },
  });
}
