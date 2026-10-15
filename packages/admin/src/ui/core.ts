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
  listRuns(filter: { workflow?: string; status?: any; before?: number; limit?: number }, env?: any): Promise<any[]>;
  getRun(id: string, env?: any): Promise<any>;
  cancel(id: string, env?: any): Promise<unknown>;
  retry(id: string, env?: any): Promise<unknown>;
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
  /** The System area exists and this user may read it. */
  system: boolean;
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

/** Can this user open the System area? Asks its API (app-wide, so without an org). */
export async function systemVisible(core: Core, ctx: Context): Promise<boolean> {
  return (await sub(core.app, ctx, "GET", `${core.apiBase}/_admin/system`, { org: null })).ok;
}

export async function pageData(core: Core, ctx: Context): Promise<PageData> {
  const [schema, orgs, system] = await Promise.all([schemaFor(core, ctx), orgsFor(core, ctx), systemVisible(core, ctx)]);
  const resources = schema.resources.filter((r) => !core.only || core.only.includes(r.name));
  return { schema, resources, orgs, workflows: !!core.workflows && can(ctx, "workflows:read"), system };
}
