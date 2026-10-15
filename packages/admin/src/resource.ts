// resource(): one definition that drives the table, routes, MCP tools, events and metadata.

import { t, validate, type Context, type ObjectSchema, type Schema } from "miujs";
import { adminErrors } from "./errors.ts";
import { TEXT_LIKE, isFieldDef, isSortable, valueSchema, type FieldDef } from "./fields.ts";

type MaybePromise<T> = T | Promise<T>;
export type AdminRecord = Record<string, unknown> & { id: string };

export type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "isNull";
export const FILTER_OPS: readonly FilterOp[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "isNull"];
/** `{ stage: "lead" }` (eq) or `{ value: { gte: 1000 } }`. Date values may be `"today"`, `"today+7d"`, `"now"`. */
export type Filter = Record<string, unknown>;

export interface ViewConfig {
  label?: string;
  /** Default "table". */
  kind?: "table" | "kanban" | "calendar";
  /** kanban: a select field. */
  groupBy?: string;
  /** calendar: a date or datetime field. */
  dateField?: string;
  filter?: Filter;
  /** One field, `-` prefix for descending. */
  sort?: string;
  /** Columns to show, in order. */
  fields?: string[];
}

export interface ViewDef extends Required<Pick<ViewConfig, "label" | "kind">> {
  name: string;
  groupBy?: string;
  dateField?: string;
  filter?: Filter;
  sort?: string;
  fields?: string[];
}

/** What an action's `run` receives. `records` are already tenant scoped and permission checked. */
export interface ActionInput<I = unknown> {
  records: AdminRecord[];
  input: I;
  ctx: Context;
  /** Scoped data access to any admin resource, as the current user and organization. */
  data: DataAccess;
}

export interface ActionConfig<I = unknown> {
  label?: string;
  /** Default `<permissions>:update`. */
  permission?: string;
  /** Extra input sent with the action (validated). */
  input?: Schema<I>;
  /** Ask for confirmation in the UI. */
  confirm?: string | boolean;
  /** Most records one call may target. Default 100. */
  maxRecords?: number;
  run(args: ActionInput<I>): MaybePromise<unknown>;
}

export interface ActionDef extends ActionConfig<any> {
  name: string;
  label: string;
  permission: string;
  maxRecords: number;
}

/** Repository-like access other code (hooks, actions, workflows) uses. */
export interface DataAccess {
  (resource: string): {
    get(id: string): Promise<AdminRecord | null>;
    list(q?: { filter?: Filter; sort?: string; limit?: number; cursor?: string }): Promise<{ items: AdminRecord[]; nextCursor: string | null }>;
    create(data: Record<string, unknown>): Promise<AdminRecord>;
    update(id: string, changes: Record<string, unknown>): Promise<AdminRecord>;
    delete(id: string): Promise<void>;
  };
}

export interface HookArgs {
  resource: Resource;
  /** Undefined when called outside a request (workflow actions, scripts). */
  ctx?: Context;
  data: DataAccess;
  orgId: string | null;
  userId: string | null;
}

export interface Hooks {
  /** Return changed data to replace it; throw to refuse. */
  beforeCreate?(args: HookArgs & { input: Record<string, unknown> }): MaybePromise<Record<string, unknown> | void>;
  afterCreate?(args: HookArgs & { record: AdminRecord }): MaybePromise<void>;
  beforeUpdate?(args: HookArgs & { before: AdminRecord; changes: Record<string, unknown> }): MaybePromise<Record<string, unknown> | void>;
  afterUpdate?(args: HookArgs & { before: AdminRecord; record: AdminRecord; changed: string[] }): MaybePromise<void>;
  beforeDelete?(args: HookArgs & { record: AdminRecord }): MaybePromise<void>;
  afterDelete?(args: HookArgs & { record: AdminRecord; soft: boolean }): MaybePromise<void>;
}

export interface ResourceConfig {
  label?: string;
  /** Label for one record. Default: label without a trailing "s". */
  singular?: string;
  fields: Record<string, FieldDef>;
  /** SQL table name. Default: the resource name. */
  table?: string;
  /** `"org"`: rows belong to the active organization (@miujs/access). Default false. */
  tenant?: "org" | false;
  /** Delete sets deleted_at instead of removing the row. Default false. */
  softDelete?: boolean;
  /** createdAt, updatedAt, createdBy, updatedBy. Default true. */
  timestamps?: boolean;
  /** Permission prefix: `"contacts"` → contacts:read|create|update|delete|export|import. Default: the name. `false`: signed-in users only. */
  permissions?: string | false;
  /** SQLite FTS5 index over searchable fields for `q`. Default false (then `q` uses LIKE). */
  search?: boolean;
  /** Field shown as the record's title. Default: the first text field. */
  titleField?: string;
  /** Default list sort. Default `-createdAt` with timestamps, else `id`. */
  defaultSort?: string;
  views?: Record<string, ViewConfig>;
  actions?: Record<string, ActionConfig<any>>;
  hooks?: Hooks;
  /** Expose the routes as MCP tools. Default true. */
  mcp?: boolean;
  description?: string;
}

export interface FieldMetaBase extends FieldDef {
  name: string;
  column: string;
  label: string;
}

export interface Resource {
  readonly kind: "miu.admin.resource";
  readonly name: string;
  readonly label: string;
  readonly singular: string;
  readonly description?: string;
  readonly table: string;
  readonly fields: Readonly<Record<string, FieldMetaBase>>;
  readonly tenant: "org" | false;
  readonly softDelete: boolean;
  readonly timestamps: boolean;
  readonly permissions: Readonly<Record<"read" | "create" | "update" | "delete" | "export" | "import", string>> | null;
  readonly search: boolean;
  readonly titleField: string;
  readonly defaultSort: string;
  readonly views: Readonly<Record<string, ViewDef>>;
  readonly actions: Readonly<Record<string, ActionDef>>;
  readonly hooks: Hooks;
  readonly mcp: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const FIELD_RE = /^[a-z][A-Za-z0-9]{0,62}$/;
const PERMISSION_RE = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/i;
export const SYSTEM_FIELDS = ["id", "orgId", "createdAt", "updatedAt", "createdBy", "updatedBy", "deletedAt"];
export const QUERY_KEYS = ["filter", "sort", "cursor", "limit", "q", "fields", "view", "include"];
const RESERVED = new Set([...SYSTEM_FIELDS, ...QUERY_KEYS]);

/** `createdAt` → `created_at`. */
export function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** `nextFollowUp` → `Next follow up`, `deal_stages` → `Deal stages`. */
export function humanize(key: string): string {
  const words = snakeCase(key).split("_").filter(Boolean);
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function checkDefault(name: string, key: string, f: FieldDef): void {
  const d = f.options.default;
  if (d === undefined) return;
  if (f.type === "user" && d === "currentUser") return;
  if ((f.type === "date" || f.type === "datetime") && typeof d === "string" && /^(today|now)([+-]\d+d)?$/.test(d)) return;
  const r = validate(valueSchema(f), d);
  if (!r.ok) throw adminErrors.fieldInvalid(name, key, `default ${JSON.stringify(d)} is not valid (${r.issues[0].message})`, "Use a default that the field itself accepts.");
}

/**
 * Define an admin resource:
 *
 * ```ts
 * export const contacts = resource("contacts", {
 *   fields: { name: field.text({ required: true, searchable: true }), stage: field.select(["lead", "won"]) },
 *   tenant: "org", softDelete: true, search: true,
 * });
 * ```
 */
export function resource(name: string, config: ResourceConfig): Resource {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw adminErrors.resourceInvalid(`Invalid resource name ${JSON.stringify(name)}`, 'Use lowercase letters, digits and _, starting with a letter, e.g. resource("contacts", { ... }).');
  }
  if (!config || typeof config !== "object" || typeof config.fields !== "object" || config.fields === null) {
    throw adminErrors.resourceInvalid(`resource("${name}") needs fields`, `Pass resource("${name}", { fields: { title: field.text() } }).`);
  }
  const fields: Record<string, FieldMetaBase> = {};
  for (const [key, f] of Object.entries(config.fields)) {
    if (!FIELD_RE.test(key)) throw adminErrors.fieldInvalid(name, key, "invalid field name", "Use camelCase letters and digits, starting with a lowercase letter, e.g. nextFollowUp.");
    if (RESERVED.has(key)) throw adminErrors.fieldReserved(name, key);
    if (!isFieldDef(f)) throw adminErrors.fieldInvalid(name, key, "is not a field", "Build fields with field.text(), field.select([...]), field.relation(\"companies\"), etc.");
    if (f.options.searchable && !TEXT_LIKE.has(f.type)) {
      throw adminErrors.fieldInvalid(name, key, `${f.type} fields cannot be searchable`, "Only text, longText, richText, email, phone and url fields can be searchable.");
    }
    if ((f.type === "select" || f.type === "multiSelect") && (!f.options.choices?.length || f.options.choices.some((c) => typeof c.value !== "string" || c.value === ""))) {
      throw adminErrors.fieldInvalid(name, key, "needs at least one option", 'Pass options: field.select(["lead", "customer"]) or [{ value: "won", label: "Won" }].');
    }
    if (f.type === "relation" && (typeof f.options.target !== "string" || !NAME_RE.test(f.options.target))) {
      throw adminErrors.fieldInvalid(name, key, "needs a target resource name", 'Write field.relation("companies").');
    }
    if (f.options.required && f.options.readOnly && f.options.default === undefined) {
      throw adminErrors.fieldInvalid(name, key, "is required and readOnly without a default", "Give it a default, or drop required or readOnly.");
    }
    checkDefault(name, key, f);
    fields[key] = Object.freeze({ ...f, name: key, column: snakeCase(key), label: f.options.label ?? humanize(key) });
  }
  const timestamps = config.timestamps ?? true;
  const fieldNames = Object.keys(fields);
  const sortable = [...fieldNames.filter((k) => isSortable(fields[k])), "id", ...(timestamps ? ["createdAt", "updatedAt"] : [])];

  const search = config.search ?? false;
  if (search && !fieldNames.some((k) => fields[k].options.searchable)) throw adminErrors.searchInvalid(name);

  const titleField = config.titleField ?? fieldNames.find((k) => fields[k].type === "text") ?? fieldNames.find((k) => TEXT_LIKE.has(fields[k].type)) ?? "id";
  if (titleField !== "id" && !fields[titleField]) throw adminErrors.resourceInvalid(`resource("${name}"): titleField "${titleField}" is not a field`, `Use one of: ${fieldNames.join(", ")}.`);

  const checkSort = (s: string) => sortable.includes(s.startsWith("-") ? s.slice(1) : s);
  const defaultSort = config.defaultSort ?? (timestamps ? "-createdAt" : "id");
  if (!checkSort(defaultSort)) throw adminErrors.resourceInvalid(`resource("${name}"): cannot sort by "${defaultSort}"`, `Sort by one of: ${sortable.join(", ")}.`);

  const views: Record<string, ViewDef> = {};
  for (const [vname, v] of Object.entries(config.views ?? {})) {
    const fail = (msg: string, fix: string) => adminErrors.viewInvalid(name, vname, msg, fix);
    const kind = v.kind ?? "table";
    if (!["table", "kanban", "calendar"].includes(kind)) throw fail(`unknown kind ${JSON.stringify(kind)}`, 'Use kind "table", "kanban" or "calendar".');
    if (kind === "kanban" && (!v.groupBy || fields[v.groupBy]?.type !== "select")) throw fail("kanban needs groupBy set to a select field", "Set groupBy to a field.select(...) field, e.g. groupBy: \"stage\".");
    if (kind === "calendar" && (!v.dateField || !["date", "datetime"].includes(fields[v.dateField]?.type ?? ""))) {
      throw fail("calendar needs dateField set to a date or datetime field", 'Set dateField, e.g. dateField: "nextFollowUp".');
    }
    for (const fk of Object.keys(v.filter ?? {})) {
      if (!fields[fk] && !SYSTEM_FIELDS.includes(fk)) throw fail(`filter uses unknown field "${fk}"`, `Filter on: ${fieldNames.join(", ")}.`);
    }
    if (v.sort !== undefined && !checkSort(v.sort)) throw fail(`cannot sort by "${v.sort}"`, `Sort by one of: ${sortable.join(", ")} (prefix - for descending).`);
    for (const c of v.fields ?? []) if (!fields[c] && !SYSTEM_FIELDS.includes(c)) throw fail(`fields lists unknown field "${c}"`, `Use: ${fieldNames.join(", ")}.`);
    views[vname] = Object.freeze({ name: vname, label: v.label ?? humanize(vname), kind, ...(v.groupBy ? { groupBy: v.groupBy } : {}), ...(v.dateField ? { dateField: v.dateField } : {}), ...(v.filter ? { filter: v.filter } : {}), ...(v.sort ? { sort: v.sort } : {}), ...(v.fields ? { fields: [...v.fields] } : {}) });
  }

  const prefix = config.permissions === undefined ? name : config.permissions;
  if (prefix !== false && (typeof prefix !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/i.test(prefix))) {
    throw adminErrors.resourceInvalid(`resource("${name}"): invalid permissions ${JSON.stringify(prefix)}`, 'Use a permission resource name like "contacts", or false.');
  }
  const permissions =
    prefix === false
      ? null
      : Object.freeze({
          read: `${prefix}:read`,
          create: `${prefix}:create`,
          update: `${prefix}:update`,
          delete: `${prefix}:delete`,
          export: `${prefix}:export`,
          import: `${prefix}:import`,
        });

  const actions: Record<string, ActionDef> = {};
  for (const [aname, a] of Object.entries(config.actions ?? {})) {
    if (!NAME_RE.test(snakeCase(aname)) || !/^[a-z][A-Za-z0-9_]*$/.test(aname)) throw adminErrors.actionInvalid(name, aname, "invalid action name", "Use camelCase letters and digits, e.g. markLost.");
    if (!a || typeof a.run !== "function") throw adminErrors.actionInvalid(name, aname, "needs a run function", `Write actions: { ${aname}: { label: "…", run: async ({ records, ctx }) => { … } } }.`);
    if (a.permission !== undefined && !PERMISSION_RE.test(a.permission)) throw adminErrors.actionInvalid(name, aname, `invalid permission ${JSON.stringify(a.permission)}`, 'Write it as "resource:action", e.g. "contacts:update".');
    if (a.input !== undefined && (typeof a.input !== "object" || typeof a.input.parse !== "function")) throw adminErrors.actionInvalid(name, aname, "input must be a t schema", "Pass input: t.object({ reason: t.string() }).");
    actions[aname] = Object.freeze({
      ...a,
      name: aname,
      label: a.label ?? humanize(aname),
      permission: a.permission ?? permissions?.update ?? "",
      maxRecords: a.maxRecords ?? 100,
    });
  }
  const label = config.label ?? humanize(name);
  return Object.freeze({
    kind: "miu.admin.resource" as const,
    name,
    label,
    singular: config.singular ?? (label.endsWith("ies") ? `${label.slice(0, -3)}y` : label.endsWith("s") ? label.slice(0, -1) : label),
    description: config.description,
    table: config.table ?? name,
    fields: Object.freeze(fields),
    tenant: config.tenant ?? false,
    softDelete: config.softDelete ?? false,
    timestamps,
    permissions,
    search,
    titleField,
    defaultSort,
    views: Object.freeze(views),
    actions: Object.freeze(actions),
    hooks: Object.freeze({ ...(config.hooks ?? {}) }),
    mcp: config.mcp ?? true,
  });
}

export function isResource(v: unknown): v is Resource {
  return typeof v === "object" && v !== null && (v as Resource).kind === "miu.admin.resource";
}

/** Fields the API may write (not readOnly). */
export function writableFields(r: Resource): FieldMetaBase[] {
  return Object.values(r.fields).filter((f) => !f.options.readOnly);
}

/** Sortable keys of a resource, including system fields. */
export function sortableKeys(r: Resource): string[] {
  return [...Object.values(r.fields).filter(isSortable).map((f) => f.name), "id", ...(r.timestamps ? ["createdAt", "updatedAt"] : [])];
}

const createCache = new WeakMap<Resource, ObjectSchema<any>>();
const updateCache = new WeakMap<Resource, ObjectSchema<any>>();

/** Body schema for create: required fields required, defaults filled (except dynamic ones), others nullable. */
export function createSchema(r: Resource): ObjectSchema<Record<string, Schema<any>>> {
  let s = createCache.get(r);
  if (!s) {
    const shape: Record<string, Schema<any>> = {};
    for (const f of writableFields(r)) {
      const base = valueSchema(f);
      const d = f.options.default;
      const dynamic = typeof d === "string" && (d === "currentUser" || /^(today|now)/.test(d)) && (f.type === "user" || f.type === "date" || f.type === "datetime");
      if (f.options.required) shape[f.name] = d !== undefined && !dynamic ? t.default(base, d) : dynamic ? t.optional(base) : base;
      else shape[f.name] = d !== undefined && !dynamic ? t.default(t.nullable(base), d) : t.optional(t.nullable(base));
    }
    createCache.set(r, (s = t.object(shape)));
  }
  return s;
}

/** Body schema for update (PATCH): every field optional; only non-required fields accept null. */
export function updateSchema(r: Resource): ObjectSchema<Record<string, Schema<any>>> {
  let s = updateCache.get(r);
  if (!s) {
    const shape: Record<string, Schema<any>> = {};
    for (const f of writableFields(r)) {
      const base = valueSchema(f);
      shape[f.name] = t.optional(f.options.required ? base : t.nullable(base));
    }
    updateCache.set(r, (s = t.object(shape)));
  }
  return s;
}
