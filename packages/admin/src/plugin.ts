// The admin() plugin: routes for every resource, the schema endpoint, auto-migration in dev,
// lifecycle events through @miujs/workflows, and a server-side data API.

import { definePlugin, processEnv, type App, type CloudflareNeeds, type Context, type Env } from "miujs";
import { describeDatabase, migrateOnce, resolveDatabase, type Database, type DatabaseSource } from "@miujs/db";
import { adminErrors } from "./errors.ts";
import { adminSchema, type AdminSchema, type SchemaOptions } from "./meta.ts";
import type { AuditService } from "@miujs/audit";
import type { WorkflowsService } from "@miujs/workflows";
import { Repo, type AuditEntryIn, type Runtime, type Scope } from "./repo.ts";
import type { DataAccess, Resource } from "./resource.ts";
import { resourceRoutes, schemaRoute, type RouteEnv } from "./routes.ts";
import { adminMigrations, checkResources } from "./tables.ts";
import { createSystem } from "./system.ts";
import { appSection, ErrorCounter } from "./system-app.ts";

export interface AdminOptions {
  resources: Resource[];
  /** Route prefix. Default `/api`. */
  basePath?: string;
  /** Default: `ctx.db` from @miujs/db's db() plugin. */
  database?: DatabaseSource;
  /** Apply `adminMigrations(resources)` on first use. Default: on in dev, off in production. */
  autoMigrate?: boolean;
  /** Largest CSV import. Default 5000 rows. */
  importMaxRows?: number;
  /** Rows per database page while streaming exports. Default 500. */
  exportPageSize?: number;
  /** Serve `GET <basePath>/_admin/schema`. Default true. */
  schemaRoute?: boolean;
  /**
   * The System area: every plugin's `manage()` sections (status, lists, settings, actions) under
   * `<basePath>/_admin/system`, plus a built-in "app" section. Default true.
   */
  system?: boolean;
  /** Offer System actions as MCP tools (`system_<plugin>_<action>`). Default true. */
  systemMcp?: boolean;
  /** How long an instance trusts the System settings it read before re-reading them. Default 30 000 ms. */
  systemSettingsTtlMs?: number;
  /** Clock for the System area (uptime, settings TTL). Default `Date.now`; tests pass a fake. */
  now?: () => number;
}

export interface DataScope {
  /** Required for tenant (`tenant: "org"`) resources. */
  orgId?: string | null;
  /** Recorded as createdBy/updatedBy and used for `default: "currentUser"`. */
  userId?: string | null;
  env?: Env;
}

declare module "miujs" {
  interface Services {
    /** Server-side data access to admin resources (from @miujs/admin). */
    admin: AdminService;
  }
}

export interface AdminService {
  resources: readonly Resource[];
  /** Scoped CRUD on a resource, as a system caller (no permission checks; hooks, events still run). */
  data(scope: DataScope): DataAccess;
  schema(o?: SchemaOptions): AdminSchema;
}

/**
 * Admin + CRM backend from resource definitions:
 *
 * ```ts
 * miu({ plugins: [db(), auth(), access({ roles }), audit({ store }), workflows({ workflows }), admin({ resources: [companies, contacts] })] })
 * ```
 */
export function admin(opts: AdminOptions) {
  const resources = [...(opts?.resources ?? [])];
  const byName = checkResources(resources);
  const migrations = adminMigrations(resources);
  const basePath = (opts.basePath ?? "/api").replace(/\/$/, "");
  let app: App | null = null;
  let autoMigrate = opts.autoMigrate ?? true;
  let lastDb: Database | null = null;

  // Outside requests, events and audit rows go through the services @miujs/workflows and
  // @miujs/audit provide (whatever their plugins are named); without them, they are skipped.
  const emitOutside = async (event: string, data: Record<string, unknown>, env: Env) => {
    if (app?.hasService("workflows")) await app.service<WorkflowsService>("workflows").emit(event, data, { env });
  };
  const auditOutside = async (entries: AuditEntryIn[], scope: Scope) => {
    if (!app?.hasService("audit")) return;
    await app.service<AuditService>("audit").logMany(entries, { actor: scope.userId ?? "system", org: scope.orgId, env: scope.env });
  };

  const makeRuntime = async (database: Database): Promise<Runtime> => {
    if (autoMigrate) await migrateOnce(database, migrations);
    lastDb = database;
    return {
      db: database,
      byName,
      now: () => Date.now(),
      log: (message, data) => app?.log.error(message, data),
      auditOutside,
      emit: async (event, data, scope) => {
        try {
          const events = (scope.ctx as { events?: { emit(e: string, d: unknown): Promise<unknown> } } | undefined)?.events;
          if (events && typeof events.emit === "function") await events.emit(event, data);
          else await emitOutside(event, data, scope.env);
        } catch (err) {
          // The write is committed; a failing automation must not turn it into an error response.
          app?.log.error("admin: emitting event failed", { event, err });
        }
      },
    };
  };

  const databaseFor = (env: Env, ctx?: Context): Database => {
    if (opts.database) return resolveDatabase(opts.database, env);
    const fromCtx = (ctx as { db?: Database } | undefined)?.db;
    if (fromCtx && typeof fromCtx.prepare === "function") return fromCtx;
    if (!ctx && lastDb) return lastDb;
    throw adminErrors.databaseMissing();
  };

  const routeEnv: RouteEnv = {
    basePath,
    resources,
    byName,
    importMaxRows: opts.importMaxRows ?? 5000,
    exportPageSize: opts.exportPageSize ?? 500,
    runtime: (ctx) => makeRuntime(databaseFor(ctx.env, ctx)),
  };
  const routes = [...resources.flatMap((r) => resourceRoutes(r, routeEnv)), ...(opts.schemaRoute === false ? [] : [schemaRoute(routeEnv)])];

  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const errorCounter = new ErrorCounter();
  const system =
    opts.system === false
      ? null
      : createSystem({
          app: () => {
            if (!app) throw adminErrors.serviceMissing();
            return app;
          },
          base: `${basePath}/_admin/system`,
          builtin: () => (app ? [appSection(app, { startedAt, now, errors: errorCounter })] : []),
          mcp: opts.systemMcp !== false,
          now,
          ttlMs: opts.systemSettingsTtlMs ?? 30_000,
          database: async (ctx) => {
            const database = databaseFor(ctx.env, ctx);
            if (autoMigrate) await migrateOnce(database, migrations);
            return database;
          },
        });
  if (system) routes.push(...system.routes);

  const service: AdminService = {
    resources,
    data(scope: DataScope): DataAccess {
      const env = scope.env ?? processEnv();
      return (name: string) => {
        const r = byName.get(name);
        if (!r) throw adminErrors.resourceUnknown(name, [...byName.keys()]);
        const s: Scope = { orgId: scope.orgId ?? null, userId: scope.userId ?? null, env };
        const lazy = async () => new Repo(await makeRuntime(databaseFor(env)), r, s).client();
        return {
          get: async (id) => (await lazy()).get(id),
          list: async (q) => (await lazy()).list(q),
          create: async (d) => (await lazy()).create(d),
          update: async (id, c) => (await lazy()).update(id, c),
          delete: async (id) => (await lazy()).delete(id),
        };
      };
    },
    schema: (o = {}) => adminSchema(resources, { basePath, ...o }),
  };

  return definePlugin({
    name: "admin",
    routes,
    migrations,
    /** @internal The per-request data runtime (used by @miujs/admin/crm routes). */
    runtime: (ctx: Context) => routeEnv.runtime(ctx),
    ...service,
    setup(a: App) {
      app = a;
      if (opts.autoMigrate === undefined) autoMigrate = a.dev;
      if (!a.hasService("admin")) a.provide("admin", service);
      // One route per System action at its exact path: each becomes an MCP tool.
      if (system) a.add(system.mcpRoutes());
    },
    ...(system
      ? {
          /** Re-applies saved System settings on the first request and then once per TTL. */
          onRequest(ctx: Context) {
            return system.sync(ctx);
          },
          onError(_ctx: Context, error: unknown) {
            errorCounter.record(error, now());
          },
        }
      : {}),
    inspect() {
      return {
        basePath,
        database: opts.database ? describeDatabase(opts.database) : "ctx.db",
        autoMigrate,
        migrations: migrations.map((m) => m.id),
        resources: resources.map((r) => ({
          name: r.name,
          table: r.table,
          tenant: r.tenant,
          softDelete: r.softDelete,
          search: r.search,
          permissions: r.permissions ? Object.values(r.permissions) : null,
          fields: Object.values(r.fields).map((f) => `${f.name}:${f.type}`),
          views: Object.keys(r.views),
          actions: Object.keys(r.actions),
          events: [`${r.name}.created`, `${r.name}.updated`, `${r.name}.deleted`],
          routes: routes.filter((x) => x.config.tags?.includes(r.name)).map((x) => `${x.method} ${x.path}`),
        })),
        schema: opts.schemaRoute === false ? null : `GET ${basePath}/_admin/schema`,
        system: system ? { path: `GET ${basePath}/_admin/system`, mcp: opts.systemMcp !== false, settingsTtlMs: opts.systemSettingsTtlMs ?? 30_000 } : null,
      };
    },
    cloudflare(): CloudflareNeeds {
      const d = opts.database ? describeDatabase(opts.database) : null;
      return d && d.adapter === "d1" && typeof d.binding === "string" ? { d1: [d.binding] } : {};
    },
  });
}

export type AdminPlugin = ReturnType<typeof admin>;
