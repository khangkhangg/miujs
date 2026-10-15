import type { App } from "./app.ts";
import type { Context } from "./context.ts";
import type { RouteDef } from "./route.ts";
import type { ManageSection } from "./manage.ts";
import type { JsonSchema } from "./schema.ts";

type MaybePromise<T> = T | Promise<T>;

/** An extra MCP tool a plugin offers (for example a realtime room's `join`). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  call(args: Record<string, unknown>, ctx: Context): MaybePromise<unknown>;
}

/** Cloudflare bindings a plugin needs. `miu deploy cloudflare` turns these into wrangler config. */
export interface CloudflareNeeds {
  kv?: string[];
  d1?: string[];
  r2?: string[];
  queues?: { producers?: string[]; consumers?: string[] };
  durableObjects?: { binding: string; className: string }[];
  crons?: string[];
  /** Workers Static Assets. One folder per app; `binding` defaults to "ASSETS". */
  assets?: {
    directory: string;
    binding?: string;
    notFoundHandling?: "none" | "404-page" | "single-page-application";
    htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
    /** Run the Worker before serving assets (true, or route patterns), so routes and headers apply. */
    runWorkerFirst?: boolean | string[];
  };
  /** Cloudflare Workflows classes the app exports. */
  workflows?: { binding: string; name: string; className: string }[];
  /** Rate Limiting bindings (`[[ratelimits]]`): `limit` requests per `period` seconds (10 or 60). */
  ratelimits?: { binding: string; limit: number; period: 10 | 60 | number; namespaceId?: string }[];
  /** Workers AI (`[ai]`). One binding per app. */
  ai?: { binding: string };
  /** Vectorize indexes (`[[vectorize]]`). */
  vectorize?: { binding: string; indexName: string }[];
}

/**
 * Batteries and user extensions. Hooks are flattened into each route's pipeline at startup,
 * so a plugin costs nothing on requests it doesn't handle.
 */
export interface Plugin {
  name: string;
  /** Runs once before the first request. Register routes, Workers handlers, etc. */
  setup?(app: App): MaybePromise<void>;
  /** Extra routes this plugin serves (e.g. `/auth/login`). */
  routes?: RouteDef[];
  /** Runs after route matching, before validation and auth checks. Return a Response to short-circuit. */
  onRequest?(ctx: Context): MaybePromise<void | Response>;
  /** Runs on every response, including errors. Return a new Response to replace it. */
  onResponse?(ctx: Context, res: Response): MaybePromise<void | Response>;
  /**
   * Release what the plugin holds: timers, sockets, child processes, pollers. Called once by
   * `app.stop()` (and by stopping a server from `app.listen()`), in reverse plugin order.
   */
  stop?(): MaybePromise<void>;
  /** Sees every error thrown while handling a request (a MiuError or anything else). Observe only. */
  onError?(ctx: Context, error: unknown): MaybePromise<void>;
  /** Extra MCP tools. */
  mcpTools?(): McpTool[];
  /** Shown in `miu inspect` and `/_miu/app.json`. */
  inspect?(): unknown;
  /** Cloudflare bindings this plugin uses when deployed to Workers. */
  cloudflare?(): CloudflareNeeds;
  /**
   * What an operator can see and do with this plugin: status, lists, runtime settings and
   * actions. `@miujs/admin` renders them, checks permissions and audits every change.
   */
  manage?(): ManageSection[];
}

export function definePlugin<P extends Plugin>(plugin: P): P {
  return plugin;
}
