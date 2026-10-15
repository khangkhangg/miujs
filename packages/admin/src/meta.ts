// Metadata for admin UIs and agents: everything needed to render lists, forms, filters,
// kanban/calendar views and action buttons, without reading the resource source.

import type { JsonSchema } from "miujs";
import { currencyDigits, isSortable, operatorsFor, valueSchema, type Choice, type FieldType, type ReferenceAction } from "./fields.ts";
import { FILTER_OPS, humanize, type FilterOp, type Resource, type ViewDef } from "./resource.ts";
import { checkResources } from "./tables.ts";

export interface FieldMeta {
  name: string;
  /** SQL column. */
  column: string;
  type: FieldType;
  label: string;
  required: boolean;
  unique: boolean;
  searchable: boolean;
  sortable: boolean;
  /** Filter operators the list API accepts for this field. */
  operators: string[];
  /** Not writable through the API (system fields and `readOnly` fields). */
  readOnly: boolean;
  hidden: boolean;
  /** id, createdAt, updatedAt, createdBy, updatedBy. */
  system: boolean;
  help?: string;
  /** Static default, or `"currentUser"` / `"today"` / `"now"`. */
  default?: unknown;
  /** select / multiSelect choices, with labels filled in. Extra keys (color, probability) kept. */
  options?: (Choice & { label: string })[];
  relation?: { resource: string; path: string; titleField: string; onDelete: ReferenceAction };
  currency?: string;
  /** Decimal places of the currency's minor unit (2 for USD): display value / 10^digits. */
  currencyDigits?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  /** JSON Schema of one value (as sent in create/update bodies). */
  schema: JsonSchema;
}

export interface ActionMeta {
  name: string;
  label: string;
  permission: string;
  confirm?: string | boolean;
  maxRecords: number;
  input?: JsonSchema;
  /** Present in filtered schemas: whether the current user may run it. */
  can?: boolean;
}

export type Capability = "read" | "create" | "update" | "delete" | "export" | "import";

export interface Endpoint {
  method: string;
  path: string;
  /** MCP tool / route name. */
  tool: string;
}

export interface ResourceMeta {
  name: string;
  label: string;
  singular: string;
  description?: string;
  /** Collection URL, e.g. `/api/contacts`. */
  path: string;
  titleField: string;
  defaultSort: string;
  tenant: "org" | false;
  softDelete: boolean;
  timestamps: boolean;
  search: boolean;
  permissions: Record<Capability, string> | null;
  /** What the current user may do (all true in the unfiltered `adminSchema()`). */
  can: Record<Capability, boolean>;
  fields: FieldMeta[];
  views: ViewDef[];
  actions: ActionMeta[];
  endpoints: Record<"list" | "get" | "create" | "update" | "delete" | "bulk" | "export" | "import", Endpoint> & { action?: Endpoint };
}

export interface AdminSchema {
  version: 1;
  basePath: string;
  operators: readonly FilterOp[];
  resources: ResourceMeta[];
}

export interface SchemaOptions {
  basePath?: string;
  /** Permission check; resources the user cannot read and actions they cannot run are left out. */
  can?: (permission: string) => boolean;
}

const CAPS: Capability[] = ["read", "create", "update", "delete", "export", "import"];

function system(name: string, column: string, type: FieldType, label: string): FieldMeta {
  const def = { kind: "miu.admin.field" as const, type, options: {} };
  return {
    name,
    column,
    type,
    label,
    required: false,
    unique: name === "id",
    searchable: false,
    sortable: true,
    operators: name === "id" ? ["eq", "ne", "in"] : operatorsFor(def),
    readOnly: true,
    hidden: name !== "id" && name !== "createdAt" && name !== "updatedAt",
    system: true,
    schema: type === "datetime" ? { type: "string", format: "date-time" } : { type: "string" },
  };
}

export function resourceMeta(r: Resource, byName: Map<string, Resource>, o: SchemaOptions = {}): ResourceMeta {
  const base = (o.basePath ?? "/api").replace(/\/$/, "");
  const path = `${base}/${r.name}`;
  const allow = (p: string | undefined) => (p === undefined || !o.can ? true : o.can(p));
  const fields: FieldMeta[] = [system("id", "id", "text", "ID")];
  for (const f of Object.values(r.fields)) {
    const opt = f.options;
    const m: FieldMeta = {
      name: f.name,
      column: f.column,
      type: f.type,
      label: f.label,
      required: !!opt.required,
      unique: !!opt.unique,
      searchable: !!opt.searchable,
      sortable: isSortable(f),
      operators: operatorsFor(f),
      readOnly: !!opt.readOnly,
      hidden: !!opt.hidden,
      system: false,
      schema: valueSchema(f).json,
    };
    if (opt.help) m.help = opt.help;
    if (opt.default !== undefined) m.default = opt.default;
    if (opt.choices) m.options = opt.choices.map((c) => ({ ...c, label: c.label ?? humanize(c.value) }));
    if (f.type === "relation") {
      const target = byName.get(opt.target!);
      m.relation = { resource: opt.target!, path: `${base}/${opt.target}`, titleField: target?.titleField ?? "id", onDelete: opt.onDelete ?? "no action" };
    }
    if (f.type === "money") {
      m.currency = opt.currency;
      m.currencyDigits = currencyDigits(opt.currency ?? "USD");
    }
    if (opt.min !== undefined) m.min = opt.min;
    if (opt.max !== undefined) m.max = opt.max;
    if (f.type === "percent") {
      m.min = 0;
      m.max = 100;
    }
    if (opt.integer) m.integer = true;
    fields.push(m);
  }
  if (r.timestamps) {
    fields.push(system("createdAt", "created_at", "datetime", "Created"), system("updatedAt", "updated_at", "datetime", "Updated"), system("createdBy", "created_by", "user", "Created by"), system("updatedBy", "updated_by", "user", "Updated by"));
  }
  const can = Object.fromEntries(CAPS.map((c) => [c, allow(r.permissions?.[c])])) as Record<Capability, boolean>;
  const actions: ActionMeta[] = [];
  for (const a of Object.values(r.actions)) {
    const ok = allow(a.permission || undefined);
    if (o.can && !ok) continue;
    const meta: ActionMeta = { name: a.name, label: a.label, permission: a.permission, maxRecords: a.maxRecords };
    if (a.confirm !== undefined) meta.confirm = a.confirm;
    if (a.input) meta.input = a.input.json;
    if (o.can) meta.can = ok;
    actions.push(meta);
  }
  const ep = (method: string, p: string, tool: string): Endpoint => ({ method, path: p, tool: `${r.name}_${tool}` });
  const endpoints: ResourceMeta["endpoints"] = {
    list: ep("GET", path, "list"),
    get: ep("GET", `${path}/:id`, "get"),
    create: ep("POST", path, "create"),
    update: ep("PATCH", `${path}/:id`, "update"),
    delete: ep("DELETE", `${path}/:id`, "delete"),
    bulk: ep("POST", `${path}/bulk`, "bulk"),
    export: ep("GET", `${path}/export.csv`, "export"),
    import: ep("POST", `${path}/import`, "import"),
  };
  if (Object.keys(r.actions).length) endpoints.action = ep("POST", `${path}/actions/:action`, "action");
  return {
    name: r.name,
    label: r.label,
    singular: r.singular,
    ...(r.description ? { description: r.description } : {}),
    path,
    titleField: r.titleField,
    defaultSort: r.defaultSort,
    tenant: r.tenant,
    softDelete: r.softDelete,
    timestamps: r.timestamps,
    search: r.search,
    permissions: r.permissions ? { ...r.permissions } : null,
    can,
    fields,
    views: Object.values(r.views).map((v) => ({ ...v })),
    actions,
    endpoints,
  };
}

/**
 * The full admin schema (unfiltered unless `can` is given). `GET <basePath>/_admin/schema`
 * serves the same shape filtered by the signed-in user's permissions.
 */
export function adminSchema(resources: readonly Resource[], o: SchemaOptions = {}): AdminSchema {
  const byName = checkResources(resources);
  const out: ResourceMeta[] = [];
  for (const r of resources) {
    if (o.can && r.permissions && !o.can(r.permissions.read)) continue;
    out.push(resourceMeta(r, byName, o));
  }
  return { version: 1, basePath: (o.basePath ?? "/api").replace(/\/$/, ""), operators: FILTER_OPS, resources: out };
}
