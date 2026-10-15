// Field types: each maps to a `t` schema (API validation), a SQL column type and converters
// between API values, SQL values, filter values and CSV cells.

import { t, type JsonSchema, type Schema } from "miujs";
import { sanitizeHtml } from "./sanitize.ts";

export type FieldType =
  | "text"
  | "longText"
  | "richText"
  | "email"
  | "phone"
  | "url"
  | "number"
  | "money"
  | "percent"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "multiSelect"
  | "tags"
  | "relation"
  | "user"
  | "file"
  | "json";

export const FIELD_TYPES: readonly FieldType[] = [
  "text", "longText", "richText", "email", "phone", "url", "number", "money", "percent", "boolean",
  "date", "datetime", "select", "multiSelect", "tags", "relation", "user", "file", "json",
];

export type ReferenceAction = "cascade" | "set null" | "restrict" | "no action";

/** One option of a select / multiSelect. Extra keys (color, probability, …) are kept as metadata. */
export interface Choice {
  value: string;
  label?: string;
  color?: string;
  [key: string]: unknown;
}

export interface FieldOptions {
  label?: string;
  /** Must be present on create and never null. */
  required?: boolean;
  /** Unique (per organization when the resource is tenant scoped; ignores soft-deleted rows). */
  unique?: boolean;
  /** Indexed for full-text search (`q`). Text-like fields only. */
  searchable?: boolean;
  /** Add a plain index for filtering/sorting. */
  index?: boolean;
  /** Value used when create omits the field. `field.user` also takes `"currentUser"`. */
  default?: unknown;
  /** Help text shown under the input. */
  help?: string;
  /** Hidden from list columns by default (still readable). */
  hidden?: boolean;
  /** Not writable through the API (set by hooks or actions). */
  readOnly?: boolean;
  /** Text-like. */
  min?: number;
  max?: number;
  /** number: integers only. */
  integer?: boolean;
  /** money: ISO 4217 code. Values are integer minor units (cents). Default "USD". */
  currency?: string;
  /** select / multiSelect. */
  choices?: Choice[];
  /** relation: target resource name. */
  target?: string;
  onDelete?: ReferenceAction;
}

export interface FieldDef {
  readonly kind: "miu.admin.field";
  readonly type: FieldType;
  readonly options: FieldOptions;
}

type Common = Pick<FieldOptions, "label" | "required" | "unique" | "index" | "help" | "hidden" | "readOnly">;
type TextOpts = Common & { searchable?: boolean; default?: string; min?: number; max?: number };
type ChoiceInput = string | Choice;

function make(type: FieldType, options: FieldOptions = {}): FieldDef {
  return Object.freeze({ kind: "miu.admin.field" as const, type, options: Object.freeze({ ...options }) });
}

function choices(values: readonly ChoiceInput[]): Choice[] {
  return values.map((v) => (typeof v === "string" ? { value: v } : { ...v }));
}

/** Field builders for `resource(name, { fields })`. */
export const field = {
  text: (o: TextOpts = {}) => make("text", o),
  longText: (o: TextOpts = {}) => make("longText", o),
  /** HTML, sanitized on write (allowlisted tags and attributes; scripts and handlers removed). */
  richText: (o: TextOpts = {}) => make("richText", o),
  email: (o: TextOpts = {}) => make("email", o),
  phone: (o: TextOpts = {}) => make("phone", o),
  url: (o: TextOpts = {}) => make("url", o),
  number: (o: Common & { default?: number; min?: number; max?: number; integer?: boolean } = {}) => make("number", o),
  /** Integer minor units (cents) in `currency`. */
  money: (o: Common & { default?: number; min?: number; max?: number; currency?: string } = {}) => make("money", { currency: "USD", ...o }),
  /** 0–100. */
  percent: (o: Common & { default?: number } = {}) => make("percent", o),
  boolean: (o: Common & { default?: boolean } = {}) => make("boolean", o),
  /** Calendar date, `YYYY-MM-DD`. */
  date: (o: Common & { default?: string } = {}) => make("date", o),
  /** Point in time, ISO 8601 in and out, stored as epoch milliseconds. */
  datetime: (o: Common & { default?: string } = {}) => make("datetime", o),
  select: (values: readonly ChoiceInput[], o: Common & { default?: string } = {}) => make("select", { ...o, choices: choices(values) }),
  multiSelect: (values: readonly ChoiceInput[], o: Common & { default?: string[] } = {}) => make("multiSelect", { ...o, choices: choices(values) }),
  tags: (o: Common & { default?: string[] } = {}) => make("tags", o),
  /** Many-to-one link to another admin resource, by id. */
  relation: (target: string, o: Common & { onDelete?: ReferenceAction } = {}) => make("relation", { ...o, target }),
  /** A user id. `default: "currentUser"` fills in the signed-in user on create. */
  user: (o: Common & { default?: "currentUser" | string } = {}) => make("user", o),
  /** A file key from @miujs/files (stored as text). */
  file: (o: Common = {}) => make("file", o),
  json: (o: Common & { default?: unknown } = {}) => make("json", o),
};

export function isFieldDef(v: unknown): v is FieldDef {
  return typeof v === "object" && v !== null && (v as FieldDef).kind === "miu.admin.field" && FIELD_TYPES.includes((v as FieldDef).type);
}

export const TEXT_LIKE = new Set<FieldType>(["text", "longText", "richText", "email", "phone", "url"]);
const STRING_STORED = new Set<FieldType>([...TEXT_LIKE, "select", "relation", "user", "file", "date"]);
const JSON_STORED = new Set<FieldType>(["multiSelect", "tags", "json"]);

export function sqlType(f: FieldDef): "TEXT" | "INTEGER" | "REAL" {
  switch (f.type) {
    case "money":
    case "boolean":
    case "datetime":
      return "INTEGER";
    case "number":
      return f.options.integer ? "INTEGER" : "REAL";
    case "percent":
      return "REAL";
    default:
      return "TEXT";
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PHONE_RE = /^\+?[0-9 ().\-/]{3,40}$/;
const FILE_KEY_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9!_.*'()/-]{1,1024}$/;

export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function refine<T>(base: Schema<T>, check: (v: T) => string | null, json: JsonSchema = base.json): Schema<T> {
  return {
    kind: base.kind,
    json,
    isOptional: false,
    parse(v, path, issues, coerce) {
      const before = issues.length;
      const out = base.parse(v, path, issues, coerce);
      if (issues.length === before) {
        const problem = check(out);
        if (problem) issues.push({ path, message: problem });
      }
      return out;
    },
  };
}

function textSchema(o: FieldOptions, fallbackMax: number, extra: Parameters<typeof t.string>[0] = {}): Schema<string> {
  return t.string({ maxLength: o.max ?? fallbackMax, ...(o.min !== undefined ? { minLength: o.min } : {}), ...extra, ...(o.help ? { description: o.help } : {}) });
}

const schemaCache = new WeakMap<FieldDef, Schema<any>>();

/** The schema for one non-null value of this field. */
export function valueSchema(f: FieldDef): Schema<any> {
  const hit = schemaCache.get(f);
  if (hit) return hit;
  const o = f.options;
  let s: Schema<any>;
  switch (f.type) {
    case "text":
      s = textSchema(o, 1000);
      break;
    case "longText":
      s = textSchema(o, 100_000);
      break;
    case "richText":
      s = textSchema(o, 200_000, { description: "HTML; sanitized on save (p, br, strong, em, a, ul, ol, li, blockquote, code, pre, h1-h6)" });
      break;
    case "email":
      s = textSchema(o, 254, { format: "email" });
      break;
    case "phone":
      s = refine(textSchema(o, 40), (v) => (PHONE_RE.test(v) && /\d/.test(v) ? null : "must be a phone number"), { type: "string", maxLength: 40, description: "Phone number, e.g. +1 555 010 9999" });
      break;
    case "url":
      s = textSchema(o, 2048, { format: "url" });
      break;
    case "number":
      s = (o.integer ? t.integer : t.number)({ ...(o.min !== undefined ? { min: o.min } : {}), ...(o.max !== undefined ? { max: o.max } : {}) });
      break;
    case "money":
      s = t.integer({ min: o.min ?? -9_007_199_254_740_991, max: o.max ?? 9_007_199_254_740_991, description: `Amount in ${o.currency} minor units (e.g. cents)` });
      break;
    case "percent":
      s = t.number({ min: 0, max: 100, description: "Percent, 0-100" });
      break;
    case "boolean":
      s = t.boolean();
      break;
    case "date":
      s = refine(t.string({ format: "date" }), (v) => (isValidDate(v) ? null : "must be a real calendar date (YYYY-MM-DD)"));
      break;
    case "datetime":
      s = t.date({ description: "ISO 8601 date-time" });
      break;
    case "select":
      s = t.enum(o.choices!.map((c) => c.value));
      break;
    case "multiSelect":
      s = t.array(t.enum(o.choices!.map((c) => c.value)), { max: o.choices!.length });
      break;
    case "tags": {
      const arr = t.array(t.string({ minLength: 1, maxLength: 100 }), { max: 100 });
      s = {
        kind: "array",
        json: { ...arr.json, description: "Tags (trimmed, de-duplicated)" },
        isOptional: false,
        parse(v, path, issues, coerce) {
          // Query/form coercion: "a,b" → ["a", "b"].
          const input = coerce && typeof v === "string" ? v.split(",") : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : x)) : v;
          const out = arr.parse(input, path, issues, coerce);
          return Array.isArray(out) ? [...new Set(out.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== ""))] : out;
        },
      };
      break;
    }
    case "relation":
      s = t.string({ minLength: 1, maxLength: 200, description: `Id of a ${o.target} record` });
      break;
    case "user":
      s = t.string({ minLength: 1, maxLength: 200, description: "User id" });
      break;
    case "file":
      s = t.string({ pattern: FILE_KEY_RE, description: "File key from @miujs/files" });
      break;
    case "json":
      s = t.unknown();
      break;
  }
  schemaCache.set(f, s);
  return s;
}

/** API value → SQL value. `null` stays null. */
export function toDb(f: FieldDef, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "richText":
      return sanitizeHtml(String(v));
    case "boolean":
      return v ? 1 : 0;
    case "datetime":
      return v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
    case "multiSelect":
    case "tags":
    case "json":
      return JSON.stringify(v);
    default:
      return v;
  }
}

/** SQL value → API value. */
export function fromDb(f: FieldDef, v: unknown): unknown {
  if (f.type === "tags" || f.type === "multiSelect") {
    if (v === null || v === undefined || v === "") return [];
    try {
      const parsed = JSON.parse(String(v));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "boolean":
      return v === 1 || v === true || v === "1";
    case "datetime":
      return new Date(Number(v)).toISOString();
    case "json":
      try {
        return JSON.parse(String(v));
      } catch {
        return null;
      }
    case "money":
    case "number":
    case "percent":
      return typeof v === "bigint" ? Number(v) : v;
    default:
      return v;
  }
}

export function isJsonStored(f: FieldDef): boolean {
  return JSON_STORED.has(f.type);
}

export function isStringStored(f: FieldDef): boolean {
  return STRING_STORED.has(f.type);
}

/** Operators each field type supports in filters. */
export function operatorsFor(f: FieldDef): string[] {
  switch (f.type) {
    case "tags":
    case "multiSelect":
      return ["contains", "isNull"];
    case "json":
      return ["isNull"];
    case "boolean":
      return ["eq", "ne", "isNull"];
    case "select":
    case "relation":
    case "user":
    case "file":
      return ["eq", "ne", "in", "isNull"];
    case "number":
    case "money":
    case "percent":
    case "date":
    case "datetime":
      return ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"];
    default:
      return ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "isNull"];
  }
}

export function isSortable(f: FieldDef): boolean {
  return !JSON_STORED.has(f.type) && f.type !== "longText" && f.type !== "richText";
}

const MINOR_DIGITS = new Map<string, number>();

/** Decimal places of a currency's minor unit (USD 2, JPY 0, BHD 3). */
export function currencyDigits(currency: string): number {
  let d = MINOR_DIGITS.get(currency);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    MINOR_DIGITS.set(currency, d);
  }
  return d;
}
