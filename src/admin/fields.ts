import { t, type TSchema } from "../core/schema.ts";
import type { AdminResource, ObjectSchema, Widget } from "./types.ts";

/** A schema field, analysed once at startup: what the API accepts and what the UI renders. */
export interface FieldInfo {
  name: string;
  label: string;
  widget: Widget;
  /** The field's schema with optional/nullable/default wrappers removed. */
  base: TSchema;
  schema: TSchema;
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  /** Not writable through the JSON API (readOnly option, or an upload field). */
  readOnly: boolean;
  hidden: boolean;
  upload: boolean;
  options?: (string | number | boolean)[];
  relation?: { resource: string; labelField: string };
  help?: string;
}

const META_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

export function titleCase(name: string): string {
  const s = name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function unwrap(s: TSchema) {
  let optional = false;
  let nullable = false;
  let hasDefault = false;
  let defaultValue: unknown;
  let base = s;
  for (;;) {
    if (base.kind === "optional") optional = true;
    else if (base.kind === "nullable") nullable = true;
    else if (base.kind === "default") {
      if (!hasDefault) defaultValue = base.value;
      hasDefault = true;
    } else break;
    base = base.inner;
  }
  return { base, optional, nullable, hasDefault, defaultValue };
}

function inferWidget(base: TSchema): Widget {
  switch (base.kind) {
    case "string":
      if (base.format === "date") return "date";
      if (base.format === "date-time") return "datetime";
      return base.max !== undefined && base.max > 255 ? "textarea" : "text";
    case "number":
      return "number";
    case "boolean":
      return "checkbox";
    case "enum":
    case "literal":
      return "select";
    default:
      return "json";
  }
}

export function analyseFields(name: string, res: AdminResource): FieldInfo[] {
  if (res.schema?.kind !== "object") throw new Error(`admin(): resource "${name}" needs a t.object() schema`);
  const out: FieldInfo[] = [];
  for (const [field, schema] of Object.entries(res.schema.shape)) {
    if (META_FIELDS.has(field)) continue;
    const o = res.fields?.[field] ?? {};
    const u = unwrap(schema);
    const widget = o.widget ?? inferWidget(u.base);
    const upload = widget === "image" || widget === "file";
    if (upload && u.base.kind !== "string") throw new Error(`admin(): ${name}.${field} (${widget}) must be a string field`);
    if (widget === "relation" && !o.relation) throw new Error(`admin(): ${name}.${field} needs relation: { resource, labelField }`);
    const info: FieldInfo = {
      name: field,
      label: o.label ?? titleCase(field),
      widget,
      base: u.base,
      schema,
      optional: u.optional,
      nullable: u.nullable,
      hasDefault: u.hasDefault,
      ...(u.hasDefault ? { defaultValue: u.defaultValue } : {}),
      readOnly: !!o.readOnly || upload,
      hidden: !!o.hidden,
      upload,
    };
    if (u.base.kind === "enum") info.options = [...u.base.values];
    if (u.base.kind === "literal") info.options = [u.base.value];
    if (o.relation) info.relation = { ...o.relation };
    if (o.help) info.help = o.help;
    out.push(info);
  }
  for (const k of Object.keys(res.fields ?? {})) {
    if (!out.some((f) => f.name === k)) throw new Error(`admin(): fields.${k} is not in the "${name}" schema`);
  }
  return out;
}

/** Writable fields with their full schema: required fields stay required, defaults apply. */
export function createSchema(fields: FieldInfo[]): ObjectSchema {
  const shape: Record<string, TSchema> = {};
  for (const f of fields) if (!f.readOnly && !f.hidden) shape[f.name] = f.schema;
  return t.object(shape);
}

/** Every writable field optional and without defaults; originally-optional fields also accept null (= clear). */
export function updateSchema(fields: FieldInfo[]): ObjectSchema {
  const shape: Record<string, TSchema> = {};
  for (const f of fields) {
    if (f.readOnly || f.hidden) continue;
    const inner = f.nullable || f.optional ? t.nullable(f.base) : f.base;
    shape[f.name] = t.optional(inner);
  }
  return t.object(shape);
}

/** The visible document schema (hidden fields removed), for `_meta` / forms. */
export function visibleSchema(fields: FieldInfo[]): ObjectSchema {
  const shape: Record<string, TSchema> = {};
  for (const f of fields) if (!f.hidden) shape[f.name] = f.schema;
  return t.object(shape);
}
