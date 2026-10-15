// Shared state of one adminUI() instance and the per-request page data (schema, orgs).

import type { App, Context, RouteDef } from "miujs";
import type { ActionDef } from "@miujs/workflows";
import type { AdminSchema, ResourceMeta, SchemaOptions } from "../meta.ts";
import type { Shell } from "./layout.ts";
import { can, orgOf, sub } from "./http.ts";
import type { WorkflowLoader, WorkflowStore } from "./workflow-store.ts";

export interface AdminLike {
  name: string;
  routes: RouteDef[];
  schema(o?: SchemaOptions): AdminSchema;
  runtime?(ctx: Context): Promise<{ db: any }>;
  actions?: ActionDef[];
}

export interface WorkflowsLike {
  name: string;
  routes: RouteDef[];
  register(def: any): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
  onUnknown(fn: (what: unknown, env: Record<string, unknown>) => Promise<void> | void): void;
}

export interface Core {
  app: App;
  shell: Shell;
  path: string;
  admin: AdminLike;
  apiBase: string;
  /** Resource names shown in the UI (null: all). */
  only: string[] | null;
  orgsPath: string;
  authPath: string;
  loginUrl: string | null;
  /** e.g. /api/crm/timeline (append /:resource/:id), when crm() serves it. */
  timelinePath: string | null;
  workflows: WorkflowsLike | null;
  /** Workflows route prefix, e.g. /workflows. */
  wfPrefix: string;
  store(ctx: Context): Promise<WorkflowStore>;
  loader: WorkflowLoader | null;
  actions(): ActionDef[];
  maxUpload: number;
}

export interface PageData {
  schema: AdminSchema;
  resources: ResourceMeta[];
  orgs: { id: string; name: string }[];
  workflows: boolean;
}

/** The schema as the current user sees it in the active org (filtered by permissions). */
export async function schemaFor(core: Core, ctx: Context): Promise<AdminSchema> {
  const org = orgOf(ctx);
  const ctxOrg = (ctx as { org?: { id: string } | null }).org?.id ?? null;
  const c = (ctx as { can?: unknown }).can;
  if (typeof c === "function" && org && org !== ctxOrg) {
    // The org comes from the UI cookie, not this request: let the API resolve it.
    const r = await sub(core.app, ctx, "GET", `${core.apiBase}/_admin/schema`);
    if (r.ok) return r.data as AdminSchema;
  }
  return core.admin.schema(typeof c === "function" ? { can: (p: string) => (c as (p: string) => boolean).call(ctx, p) } : {});
}

export async function orgsFor(core: Core, ctx: Context): Promise<{ id: string; name: string }[]> {
  if (typeof (ctx as { can?: unknown }).can !== "function") return [];
  const r = await sub(core.app, ctx, "GET", core.orgsPath, { org: null });
  return r.ok && Array.isArray(r.data?.orgs) ? r.data.orgs.map((o: { id: string; name: string }) => ({ id: o.id, name: o.name })) : [];
}

export async function pageData(core: Core, ctx: Context): Promise<PageData> {
  const [schema, orgs] = await Promise.all([schemaFor(core, ctx), orgsFor(core, ctx)]);
  const resources = schema.resources.filter((r) => !core.only || core.only.includes(r.name));
  return { schema, resources, orgs, workflows: !!core.workflows && can(ctx, "workflows:read") };
}
