// Shared, per-plugin state: where the database and files live, secrets, options.
import { type Context, type Env, type Logger } from "miujs";
import { d1, migrateOnce, resolveDatabase, sqlite, type DatabaseSource } from "@miujs/db";
import { memoryStore, type FileStore } from "@miujs/files";
import { targetRuntime } from "miujs";
import { tourErrors } from "./errors.ts";
import { tourMigrations } from "./migrations.ts";
import type { TourProcessor } from "./processor.ts";
import { TourStore } from "./store.ts";

export const MIN_SECRET = 32;

/** The rooms plugin from @miujs/realtime (only `createRoom` is used). */
export interface LiveRooms {
  createRoom(type: string, opts?: { data?: unknown; env?: Record<string, unknown> }): Promise<{ id: string; code: string }>;
}

export interface ViewerAssetsSelfHosted {
  /** URL path where the vendored viewer files are served (see VIEWER_ASSETS), e.g. "/vendor/tour". */
  basePath: string;
}

export interface TourOptions {
  /** Default: `d1("DB")` on Workers, an in-memory SQLite database elsewhere. Pass the one you give db(). */
  database?: DatabaseSource;
  /**
   * Where source files and processed tiles live. Pass the same store as files({ store }), so
   * signed URLs and jobs see the same objects. Default: memoryStore() (development only).
   */
  store?: FileStore;
  /** HMAC secret(s) for share links, unlock cookies and tile URLs. Default env TOUR_SECRET, FILES_SECRET, SESSION_SECRET. */
  secret?: string | string[];
  /** Route prefix. Default "/tours". */
  basePath?: string;
  /** Tried in order; the first one that implements a step runs it. */
  processors?: TourProcessor[];
  /** The realtime rooms plugin, for live guided tours (`rooms({ rooms: [guidedTour] })`). */
  live?: LiveRooms;
  /** Load the viewer libraries from a pinned CDN (default) or from your own static files. */
  viewerAssets?: "cdn" | ViewerAssetsSelfHosted;
  /** Visitor analytics. `false` turns the beacon route off. */
  analytics?: false | AnalyticsOptions;
  /** Signed asset URL lifetimes, in seconds. */
  urls?: {
    /** Private/unlisted tours. Default 600 (10 minutes). */
    privateTtl?: number;
    /** Public tours: URLs are stable for a day and valid for 6-7 days, so browsers and CDNs cache them. */
    publicTtl?: number;
  };
  /** Largest direct upload, per kind, in bytes. Bigger files go through @miujs/files multipart uploads. */
  maxUploadSize?: { pano?: number; model?: number; image?: number };
  /** How long an unlocked (password) tour stays open in this browser. Default 12 hours. */
  unlockTtl?: number;
  /** @internal Time source for tests. */
  now?: () => number;
}

export interface AnalyticsOptions {
  /** Beacon requests per minute per client. Default 30 (burst 10). */
  perMinute?: number;
  burst?: number;
  /** Keep raw events this many days (aggregates are kept). Default 30. */
  retentionDays?: number;
  /**
   * A Cloudflare Rate Limiting binding (`[[ratelimits]]`) to use on Workers, where in-memory
   * limits are per isolate. Declared in cloudflare().
   */
  rateLimitBinding?: string;
}

export interface TourRuntime {
  readonly basePath: string;
  readonly opts: TourOptions;
  readonly processors: TourProcessor[];
  dev: boolean;
  log: Logger | null;
  now(): number;
  source(): DatabaseSource;
  /** The store for this env, with migrations applied. */
  data(env: Env): Promise<TourStore>;
  files(env: Env): FileStore;
  secrets(env: Env, log?: Logger): string[];
}

function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function createRuntime(opts: TourOptions): TourRuntime {
  const basePath = (opts.basePath ?? "/tours").replace(/\/+$/, "");
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath)) {
    throw tourErrors.config("CONFIG", `Invalid basePath ${JSON.stringify(opts.basePath)}`, 'Use an absolute path without a trailing slash, e.g. "/tours".');
  }
  let source: DatabaseSource | undefined = opts.database;
  const store = opts.store ?? memoryStore();
  let devSecret: string | undefined;
  let warned = false;
  const rt: TourRuntime = {
    basePath,
    opts,
    processors: opts.processors ?? [],
    dev: true,
    log: null,
    now: opts.now ?? Date.now,
    source: () => (source ??= targetRuntime() === "workerd" ? d1("DB") : sqlite()),
    async data(env) {
      const db = resolveDatabase(rt.source(), env);
      await migrateOnce(db, tourMigrations);
      return new TourStore(db, rt.now);
    },
    files: (env) => (store.forEnv ? store.forEnv(env) : store),
    secrets(env, log) {
      const raw = opts.secret ?? ((env?.TOUR_SECRET as string) || (env?.FILES_SECRET as string) || (env?.SESSION_SECRET as string) || undefined);
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((s) => typeof s === "string" && s !== "");
      if (!list.length) {
        if (!rt.dev) throw tourErrors.secretMissing();
        if (!warned) {
          warned = true;
          (log ?? rt.log)?.warn("TOUR_SECRET is not set; signing tour links with a random secret for this process. Set TOUR_SECRET (32+ chars) before deploying.");
        }
        return [(devSecret ??= randomSecret())];
      }
      if (list.some((s) => s.length < MIN_SECRET)) throw tourErrors.secretWeak();
      return list;
    },
  };
  return rt;
}

/**
 * The tenant filter for this request: the active org from @miujs/access (`null` = tours without
 * an org), or `undefined` when no access plugin is installed (single-tenant apps).
 */
export function orgScope(ctx: Context): string | null | undefined {
  const c = ctx as unknown as { org?: { id?: string } | null };
  if (!("org" in (ctx as object))) return undefined;
  return c.org?.id ?? null;
}
