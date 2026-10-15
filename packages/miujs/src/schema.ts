// The `t` schema builder: one schema gives types, validation, OpenAPI and MCP input schemas.
// Validators are composed closures built once at startup. No `eval`/`new Function`, so they
// also run on Cloudflare Workers, which forbid runtime code generation.

export type JsonSchema = Record<string, unknown>;

export interface Issue {
  /** Dotted path to the bad value, e.g. `body.items.2.qty`. */
  path: string;
  message: string;
}

export interface Schema<T = unknown> {
  readonly kind: string;
  readonly json: JsonSchema;
  readonly isOptional: boolean;
  /**
   * Checks `value`, pushing problems onto `issues`, and returns the (possibly coerced) value.
   * `coerce` turns strings into numbers/booleans/arrays; it is on for params and query.
   */
  parse(value: unknown, path: string, issues: Issue[], coerce: boolean): T;
  /** Type-only marker so `Infer` can recover `T`. */
  readonly __type?: T;
  /** The wrapped schema, for `t.optional`, `t.nullable` and `t.default`. */
  readonly inner?: Schema;
}

export interface OptionalSchema<T> extends Schema<T> {
  readonly isOptional: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<any>>;
// `t.default` is optional on input but always filled on output, so it is not an optional key.
type OptionalKeys<P extends Shape> = {
  [K in keyof P]: P[K] extends { isOptional: true } ? (P[K] extends { __default: true } ? never : K) : never;
}[keyof P];
type RequiredKeys<P extends Shape> = Exclude<keyof P, OptionalKeys<P>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<P extends Shape> = Simplify<
  { [K in RequiredKeys<P>]: Infer<P[K]> } & { [K in OptionalKeys<P>]?: Exclude<Infer<P[K]>, undefined> }
>;

interface Common {
  description?: string;
  example?: unknown;
}

function schema<T>(kind: string, json: JsonSchema, parse: Schema<T>["parse"], opts?: Common): Schema<T> {
  const full: JsonSchema = { ...json };
  if (opts?.description) full.description = opts.description;
  if (opts?.example !== undefined) full.examples = [opts.example];
  return { kind, json: full, isOptional: false, parse };
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

const FORMATS: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^https?:\/\/[^\s]+$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
};

export interface StringOptions extends Common {
  minLength?: number;
  maxLength?: number;
  /** A RegExp, or a pattern string (compiled once with `new RegExp`, which Workers allow). */
  pattern?: RegExp | string;
  format?: "uuid" | "email" | "url" | "date" | "date-time";
}

function string(opts: StringOptions = {}): Schema<string> {
  const json: JsonSchema = { type: "string" };
  if (opts.minLength !== undefined) json.minLength = opts.minLength;
  if (opts.maxLength !== undefined) json.maxLength = opts.maxLength;
  const pattern = typeof opts.pattern === "string" ? new RegExp(opts.pattern) : opts.pattern;
  if (pattern) json.pattern = pattern.source;
  if (opts.format) json.format = opts.format;
  const format = opts.format ? FORMATS[opts.format] : undefined;
  const { minLength, maxLength } = opts;
  return schema("string", json, (v, path, issues) => {
    if (typeof v !== "string") {
      issues.push({ path, message: `expected string, got ${typeName(v)}` });
      return v as string;
    }
    if (minLength !== undefined && v.length < minLength) issues.push({ path, message: `must be at least ${minLength} characters` });
    if (maxLength !== undefined && v.length > maxLength) issues.push({ path, message: `must be at most ${maxLength} characters` });
    if (pattern && !pattern.test(v)) issues.push({ path, message: `must match ${pattern}` });
    if (format && !format.test(v)) issues.push({ path, message: `must be a valid ${opts.format}` });
    return v;
  }, opts);
}

export interface NumberOptions extends Common {
  min?: number;
  max?: number;
  integer?: boolean;
}

function number(opts: NumberOptions = {}): Schema<number> {
  const json: JsonSchema = { type: opts.integer ? "integer" : "number" };
  if (opts.min !== undefined) json.minimum = opts.min;
  if (opts.max !== undefined) json.maximum = opts.max;
  const { min, max, integer } = opts;
  return schema(opts.integer ? "integer" : "number", json, (v, path, issues, coerce) => {
    let n = v;
    if (coerce && typeof v === "string" && v.trim() !== "") n = Number(v);
    if (typeof n !== "number" || Number.isNaN(n)) {
      issues.push({ path, message: `expected ${integer ? "integer" : "number"}, got ${typeName(v)}` });
      return v as number;
    }
    if (integer && !Number.isInteger(n)) issues.push({ path, message: "must be an integer" });
    if (min !== undefined && n < min) issues.push({ path, message: `must be >= ${min}` });
    if (max !== undefined && n > max) issues.push({ path, message: `must be <= ${max}` });
    return n;
  }, opts);
}

function boolean(opts: Common = {}): Schema<boolean> {
  return schema("boolean", { type: "boolean" }, (v, path, issues, coerce) => {
    if (typeof v === "boolean") return v;
    if (coerce && typeof v === "string") {
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
    }
    issues.push({ path, message: `expected boolean, got ${typeName(v)}` });
    return v as boolean;
  }, opts);
}

function literal<const V extends string | number | boolean>(value: V, opts: Common = {}): Schema<V> {
  return schema("literal", { const: value }, (v, path, issues, coerce) => {
    if (v === value) return v as V;
    if (coerce && typeof v === "string" && String(value) === v) return value;
    issues.push({ path, message: `expected ${JSON.stringify(value)}` });
    return v as V;
  }, opts);
}

function enumOf<const V extends readonly (string | number)[]>(values: V, opts: Common = {}): Schema<V[number]> {
  const set = new Set<unknown>(values);
  const allStrings = values.every((x) => typeof x === "string");
  const json: JsonSchema = { enum: [...values] };
  if (allStrings) json.type = "string";
  return schema("enum", json, (v, path, issues, coerce) => {
    if (set.has(v)) return v as V[number];
    if (coerce && typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (set.has(n)) return n as V[number];
    }
    issues.push({ path, message: `expected one of ${values.map((x) => JSON.stringify(x)).join(", ")}` });
    return v as V[number];
  }, opts);
}

export interface ArrayOptions extends Common {
  min?: number;
  max?: number;
}

function array<S extends Schema<any>>(item: S, opts: ArrayOptions = {}): Schema<Infer<S>[]> {
  const json: JsonSchema = { type: "array", items: item.json };
  if (opts.min !== undefined) json.minItems = opts.min;
  if (opts.max !== undefined) json.maxItems = opts.max;
  const { min, max } = opts;
  return schema("array", json, (v, path, issues, coerce) => {
    let arr = v;
    if (coerce && !Array.isArray(v) && v !== undefined) arr = [v];
    if (!Array.isArray(arr)) {
      issues.push({ path, message: `expected array, got ${typeName(v)}` });
      return v as Infer<S>[];
    }
    if (min !== undefined && arr.length < min) issues.push({ path, message: `must have at least ${min} items` });
    if (max !== undefined && arr.length > max) issues.push({ path, message: `must have at most ${max} items` });
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = item.parse(arr[i], join(path, i), issues, coerce);
    return out;
  }, opts);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An object type plus its `rest` keys. */
type WithRest<P extends Shape, R> = R extends Schema<infer V> ? ObjectOf<P> & { [key: string]: V } : ObjectOf<P>;

export interface ObjectSchema<P extends Shape, T = ObjectOf<P>> extends Schema<T> {
  readonly shape: P;
}

export interface ObjectOptions extends Common {
  /** Keep keys not in the shape, validating each value with this schema (JSON Schema `additionalProperties`). */
  rest?: Schema<any>;
}

function object<P extends Shape, R extends Schema<any> | undefined = undefined>(shape: P, opts: ObjectOptions & { rest?: R } = {}): ObjectSchema<P, WithRest<P, R>> {
  const keys = Object.keys(shape);
  const rest = opts.rest;
  const known = new Set(keys);
  const required = keys.filter((k) => !shape[k].isOptional);
  const properties: JsonSchema = {};
  for (const k of keys) properties[k] = shape[k].json;
  const json: JsonSchema = { type: "object", properties };
  if (required.length) json.required = required;
  if (rest) json.additionalProperties = rest.json;
  // Child paths ("params.id") for the first path this schema is parsed at. A top-level schema
  // always sees the same path, so it builds no strings per request; other paths join as before.
  let firstPath: string | undefined;
  let firstPaths: string[] = [];
  const base = schema<ObjectOf<P>>("object", json, (v, path, issues, coerce) => {
    if (!isPlainObject(v)) {
      issues.push({ path, message: `expected object, got ${typeName(v)}` });
      return v as ObjectOf<P>;
    }
    if (firstPath === undefined) {
      firstPath = path;
      firstPaths = keys.map((k) => join(path, k));
    }
    const paths = path === firstPath ? firstPaths : null;
    // Unknown keys are dropped so handlers only ever see declared fields.
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const s = shape[k];
      const value = v[k];
      if (value === undefined && s.isOptional) {
        const d = s.parse(undefined, paths ? paths[i] : join(path, k), issues, coerce);
        if (d !== undefined) out[k] = d;
        continue;
      }
      if (value === undefined) {
        issues.push({ path: paths ? paths[i] : join(path, k), message: "is required" });
        continue;
      }
      out[k] = s.parse(value, paths ? paths[i] : join(path, k), issues, coerce);
    }
    if (rest) {
      for (const k of Object.keys(v)) {
        if (known.has(k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;
        Object.defineProperty(out, k, { value: rest.parse(v[k], join(path, k), issues, coerce), enumerable: true, writable: true, configurable: true });
      }
    }
    return out as ObjectOf<P>;
  }, opts);
  return { ...base, shape } as unknown as ObjectSchema<P, WithRest<P, R>>;
}

function record<S extends Schema<any>>(value: S, opts: Common = {}): Schema<Record<string, Infer<S>>> {
  return schema("record", { type: "object", additionalProperties: value.json }, (v, path, issues, coerce) => {
    if (!isPlainObject(v)) {
      issues.push({ path, message: `expected object, got ${typeName(v)}` });
      return v as Record<string, Infer<S>>;
    }
    const out: Record<string, Infer<S>> = {};
    // Own keys only, and defineProperty so a JSON `__proto__` key stays plain data instead of
    // replacing the output object's prototype.
    for (const k of Object.keys(v)) {
      const parsed = value.parse(v[k], join(path, k), issues, coerce);
      Object.defineProperty(out, k, { value: parsed, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }, opts);
}

function union<const S extends readonly Schema<any>[]>(options: S, opts: Common = {}): Schema<Infer<S[number]>> {
  return schema("union", { anyOf: options.map((o) => o.json) }, (v, path, issues, coerce) => {
    for (const o of options) {
      const local: Issue[] = [];
      const out = o.parse(v, path, local, coerce);
      if (local.length === 0) return out;
    }
    issues.push({ path, message: `did not match any of: ${options.map((o) => o.kind).join(", ")}` });
    return v as Infer<S[number]>;
  }, opts);
}

function optional<T>(inner: Schema<T>): OptionalSchema<T | undefined> {
  return {
    kind: inner.kind,
    json: inner.json,
    isOptional: true,
    inner,
    parse: (v, path, issues, coerce) => (v === undefined ? undefined : inner.parse(v, path, issues, coerce)),
  };
}

/** Optional on input, but always present (filled with `value`) on output. */
function withDefault<T>(inner: Schema<T>, value: T): OptionalSchema<T> & { readonly __default: true } {
  return {
    kind: inner.kind,
    json: { ...inner.json, default: value },
    isOptional: true,
    __default: true,
    inner,
    // Clone object defaults so one request mutating its value cannot leak into the next.
    parse: (v, path, issues, coerce) =>
      v === undefined
        ? typeof value === "object" && value !== null
          ? structuredClone(value)
          : value
        : inner.parse(v, path, issues, coerce),
  };
}

function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return {
    kind: inner.kind,
    json: { anyOf: [inner.json, { type: "null" }] },
    isOptional: inner.isOptional,
    inner,
    parse: (v, path, issues, coerce) => (v === null ? null : inner.parse(v, path, issues, coerce)),
  };
}

/** A point in time. Accepts a Date or an ISO 8601 string (JSON bodies, query) and returns a Date. */
function date(opts: Common = {}): Schema<Date> {
  return schema("date", { type: "string", format: "date-time" }, (v, path, issues) => {
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) issues.push({ path, message: "is an invalid date" });
      return v;
    }
    if (typeof v === "string" && FORMATS["date-time"].test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
    issues.push({ path, message: `expected an ISO 8601 date-time, got ${typeName(v)}` });
    return v as Date;
  }, opts);
}

function any(opts: Common = {}): Schema<any> {
  return schema("any", {}, (v) => v, opts);
}

function unknown(opts: Common = {}): Schema<unknown> {
  return schema("unknown", {}, (v) => v, opts);
}

export const t = {
  date,
  string,
  number,
  integer: (opts: Omit<NumberOptions, "integer"> = {}) => number({ ...opts, integer: true }),
  boolean,
  literal,
  enum: enumOf,
  array,
  object,
  record,
  union,
  optional,
  default: withDefault,
  nullable,
  any,
  unknown,
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export function validate<T>(s: Schema<T>, value: unknown, opts: { coerce?: boolean; path?: string } = {}): ValidationResult<T> {
  const issues: Issue[] = [];
  const out = s.parse(value, opts.path ?? "", issues, opts.coerce ?? false);
  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}

export function isSchema(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && typeof (v as Schema).parse === "function" && "json" in v;
}
