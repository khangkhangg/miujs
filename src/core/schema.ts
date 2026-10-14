/**
 * Tiny built-in schema builder. Every schema is plain data, so it can be
 * validated, converted to JSON Schema (for OpenAPI / MCP tools), and inferred
 * as a TypeScript type. Any Standard Schema (zod, valibot, arktype) also works
 * wherever a schema is accepted.
 */

export interface Issue {
  path: (string | number)[];
  message: string;
}

export type Result<T = unknown> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface ValidateOptions {
  /** Coerce strings to numbers/booleans (used for params, query, headers). */
  coerce?: boolean;
}

interface Meta {
  description?: string;
  example?: unknown;
}

export type TSchema =
  | ({ kind: "string"; min?: number; max?: number; pattern?: string; format?: StringFormat } & Meta)
  | ({ kind: "number"; integer?: boolean; min?: number; max?: number } & Meta)
  | ({ kind: "boolean" } & Meta)
  | ({ kind: "literal"; value: string | number | boolean } & Meta)
  | ({ kind: "enum"; values: readonly (string | number)[] } & Meta)
  | ({ kind: "array"; items: TSchema; min?: number; max?: number } & Meta)
  | ({ kind: "object"; shape: Record<string, TSchema> } & Meta)
  | ({ kind: "record"; values: TSchema } & Meta)
  | ({ kind: "union"; options: TSchema[] } & Meta)
  | ({ kind: "optional"; inner: TSchema } & Meta)
  | ({ kind: "nullable"; inner: TSchema } & Meta)
  | ({ kind: "default"; inner: TSchema; value: unknown } & Meta)
  | ({ kind: "any" } & Meta);

export type StringFormat = "email" | "uuid" | "url" | "date-time" | "date";

export interface StandardSchema<T = unknown> {
  "~standard": {
    version: 1;
    vendor: string;
    validate: (
      value: unknown,
    ) =>
      | { value: T; issues?: undefined }
      | { issues: readonly { message: string; path?: readonly unknown[] }[] }
      | Promise<{ value: T; issues?: undefined } | { issues: readonly { message: string; path?: readonly unknown[] }[] }>;
    types?: { input: unknown; output: T };
  };
}

export type AnySchema = TSchema | StandardSchema;

// ---------- type inference ----------

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<S extends Record<string, TSchema>> = {
  [K in keyof S]: S[K] extends { kind: "optional" } ? K : never;
}[keyof S];

export type Infer<S> = InferD<S, []>;

// D bounds recursion depth so generic code over `TSchema` (itself recursive) type-checks.
type InferD<S, D extends unknown[]> = D["length"] extends 10
  ? unknown
  : S extends { kind: string }
    ? InferT<S, [...D, 0]>
    : S extends StandardSchema<infer T>
      ? T
      : unknown;

type InferT<S, D extends unknown[]> = S extends { kind: "string" }
  ? string
  : S extends { kind: "number" }
    ? number
    : S extends { kind: "boolean" }
      ? boolean
      : S extends { kind: "literal"; value: infer V }
        ? V
        : S extends { kind: "enum"; values: readonly (infer V)[] }
          ? V
          : S extends { kind: "array"; items: infer I }
            ? InferD<I, D>[]
            : S extends { kind: "object"; shape: infer Sh extends Record<string, TSchema> }
              ? Simplify<
                  { [K in Exclude<keyof Sh, OptionalKeys<Sh>>]: InferD<Sh[K], D> } & {
                    [K in OptionalKeys<Sh>]?: InferD<Sh[K], D>;
                  }
                >
              : S extends { kind: "record"; values: infer V }
                ? Record<string, InferD<V, D>>
                : S extends { kind: "union"; options: (infer O)[] }
                  ? InferD<O, D>
                  : S extends { kind: "optional"; inner: infer I }
                    ? InferD<I, D> | undefined
                    : S extends { kind: "nullable"; inner: infer I }
                      ? InferD<I, D> | null
                      : S extends { kind: "default"; inner: infer I }
                        ? InferD<I, D>
                        : unknown;

// ---------- builder ----------

type StringOpts = { min?: number; max?: number; pattern?: string; format?: StringFormat } & Meta;
type NumberOpts = { min?: number; max?: number } & Meta;

export const t = {
  string: (o: StringOpts = {}) => ({ kind: "string" as const, ...o }),
  number: (o: NumberOpts = {}) => ({ kind: "number" as const, ...o }),
  integer: (o: NumberOpts = {}) => ({ kind: "number" as const, integer: true, ...o }),
  boolean: (o: Meta = {}) => ({ kind: "boolean" as const, ...o }),
  literal: <const V extends string | number | boolean>(value: V, o: Meta = {}) => ({
    kind: "literal" as const,
    value,
    ...o,
  }),
  enum: <const V extends readonly (string | number)[]>(values: V, o: Meta = {}) => ({
    kind: "enum" as const,
    values,
    ...o,
  }),
  array: <I extends TSchema>(items: I, o: { min?: number; max?: number } & Meta = {}) => ({
    kind: "array" as const,
    items,
    ...o,
  }),
  object: <S extends Record<string, TSchema>>(shape: S, o: Meta = {}) => ({ kind: "object" as const, shape, ...o }),
  record: <V extends TSchema>(values: V, o: Meta = {}) => ({ kind: "record" as const, values, ...o }),
  union: <O extends TSchema[]>(...options: O) => ({ kind: "union" as const, options }),
  optional: <I extends TSchema>(inner: I) => ({ kind: "optional" as const, inner }),
  nullable: <I extends TSchema>(inner: I) => ({ kind: "nullable" as const, inner }),
  default: <I extends TSchema>(inner: I, value: Infer<I>) => ({ kind: "default" as const, inner, value: value as unknown }),
  any: (o: Meta = {}) => ({ kind: "any" as const, ...o }),
};

// ---------- validation ----------

export function isStandardSchema(s: unknown): s is StandardSchema {
  return typeof s === "object" && s !== null && "~standard" in s;
}

export type ValidateResult<S> = S extends { kind: string }
  ? Result<Infer<S>>
  : Result<Infer<S>> | Promise<Result<Infer<S>>>;

/** Synchronous for built-in `t` schemas; may return a Promise for Standard Schemas. */
export const validate = validateAny as <S extends AnySchema>(
  schema: S,
  value: unknown,
  opts?: ValidateOptions,
) => ValidateResult<S>;

function validateAny(schema: AnySchema, value: unknown, opts: ValidateOptions = {}): Result | Promise<Result> {
  if (isStandardSchema(schema)) {
    const out = schema["~standard"].validate(value);
    return out instanceof Promise ? out.then(fromStandard) : fromStandard(out);
  }
  const issues: Issue[] = [];
  const v = check(schema, value, [], issues, opts.coerce ?? false);
  return issues.length ? { ok: false, issues } : { ok: true, value: v };
}

function fromStandard(r: {
  value?: unknown;
  issues?: readonly { message: string; path?: readonly unknown[] }[];
}): Result {
  if (r.issues) {
    return {
      ok: false,
      issues: r.issues.map((i) => ({
        message: i.message,
        path: (i.path ?? []).map((p) =>
          typeof p === "object" && p !== null && "key" in p ? (p as { key: string | number }).key : (p as string | number),
        ),
      })),
    };
  }
  return { ok: true, value: r.value };
}

const FORMATS: Record<StringFormat, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  url: /^https?:\/\/\S+$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

function check(s: TSchema, v: unknown, path: Issue["path"], issues: Issue[], coerce: boolean): unknown {
  // `path` is a shared stack (pushed/popped around children); copy it only when recording an issue.
  const fail = (message: string) => {
    issues.push({ path: path.slice(), message });
    return undefined;
  };
  switch (s.kind) {
    case "any":
      return v;
    case "string": {
      if (typeof v !== "string") return fail("Expected string");
      if (s.min !== undefined && v.length < s.min) return fail(`Must be at least ${s.min} characters`);
      if (s.max !== undefined && v.length > s.max) return fail(`Must be at most ${s.max} characters`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) return fail(`Must match ${s.pattern}`);
      if (s.format && !FORMATS[s.format].test(v)) return fail(`Invalid ${s.format}`);
      return v;
    }
    case "number": {
      let n = v;
      if (coerce && typeof v === "string" && v.trim() !== "") n = Number(v);
      if (typeof n !== "number" || Number.isNaN(n)) return fail(s.integer ? "Expected integer" : "Expected number");
      if (s.integer && !Number.isInteger(n)) return fail("Expected integer");
      if (s.min !== undefined && n < s.min) return fail(`Must be >= ${s.min}`);
      if (s.max !== undefined && n > s.max) return fail(`Must be <= ${s.max}`);
      return n;
    }
    case "boolean": {
      if (coerce && typeof v === "string") {
        if (v === "true" || v === "1") return true;
        if (v === "false" || v === "0") return false;
      }
      return typeof v === "boolean" ? v : fail("Expected boolean");
    }
    case "literal": {
      const lit = coerce && typeof v === "string" && typeof s.value !== "string" ? String(s.value) === v : v === s.value;
      return lit ? s.value : fail(`Expected ${JSON.stringify(s.value)}`);
    }
    case "enum": {
      const found = s.values.find((x) => x === v || (coerce && typeof v === "string" && String(x) === v));
      return found !== undefined ? found : fail(`Expected one of ${s.values.map((x) => JSON.stringify(x)).join(", ")}`);
    }
    case "array": {
      let arr = v;
      if (coerce && !Array.isArray(v) && v !== undefined) arr = [v];
      if (!Array.isArray(arr)) return fail("Expected array");
      if (s.min !== undefined && arr.length < s.min) return fail(`Must have at least ${s.min} items`);
      if (s.max !== undefined && arr.length > s.max) return fail(`Must have at most ${s.max} items`);
      const items = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        path.push(i);
        items[i] = check(s.items, arr[i], path, issues, coerce);
        path.pop();
      }
      return items;
    }
    case "object": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("Expected object");
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key in s.shape) {
        const sub = s.shape[key]!;
        const raw = src[key];
        if (raw === undefined) {
          if (sub.kind === "optional") continue;
          if (sub.kind === "default") {
            out[key] = sub.value;
            continue;
          }
          issues.push({ path: [...path, key], message: "Required" });
          continue;
        }
        path.push(key);
        out[key] = check(sub, raw, path, issues, coerce);
        path.pop();
      }
      return out;
    }
    case "record": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("Expected object");
      const out: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(v)) {
        path.push(k);
        out[k] = check(s.values, raw, path, issues, coerce);
        path.pop();
      }
      return out;
    }
    case "union": {
      for (const opt of s.options) {
        const sub: Issue[] = [];
        const r = check(opt, v, path, sub, coerce);
        if (!sub.length) return r;
      }
      return fail("No union variant matched");
    }
    case "optional":
      return v === undefined ? undefined : check(s.inner, v, path, issues, coerce);
    case "nullable":
      return v === null ? null : check(s.inner, v, path, issues, coerce);
    case "default":
      return v === undefined ? s.value : check(s.inner, v, path, issues, coerce);
  }
}

// ---------- JSON Schema ----------

export type JSONSchema = Record<string, unknown>;

export function toJSONSchema(s: AnySchema): JSONSchema {
  if (isStandardSchema(s)) {
    // zod v4 and others expose toJSONSchema; otherwise fall back to "anything".
    const anyS = s as unknown as { toJSONSchema?: () => JSONSchema };
    return typeof anyS.toJSONSchema === "function" ? anyS.toJSONSchema() : {};
  }
  const meta: JSONSchema = {};
  if (s.description) meta.description = s.description;
  if (s.example !== undefined) meta.examples = [s.example];
  switch (s.kind) {
    case "any":
      return { ...meta };
    case "string":
      return clean({
        type: "string",
        ...meta,
        minLength: s.min,
        maxLength: s.max,
        pattern: s.pattern,
        format: s.format,
      });
    case "number":
      return clean({ type: s.integer ? "integer" : "number", ...meta, minimum: s.min, maximum: s.max });
    case "boolean":
      return { type: "boolean", ...meta };
    case "literal":
      return { type: typeof s.value, const: s.value, ...meta };
    case "enum":
      return { type: typeof s.values[0] === "number" ? "number" : "string", ...meta, enum: [...s.values] };
    case "array":
      return clean({ type: "array", ...meta, items: toJSONSchema(s.items), minItems: s.min, maxItems: s.max });
    case "object": {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const [k, sub] of Object.entries(s.shape)) {
        properties[k] = toJSONSchema(sub);
        if (sub.kind !== "optional" && sub.kind !== "default") required.push(k);
      }
      return clean({
        type: "object",
        ...meta,
        properties,
        required: required.length ? required : undefined,
        additionalProperties: false,
      });
    }
    case "record":
      return { type: "object", ...meta, additionalProperties: toJSONSchema(s.values) };
    case "union":
      return { anyOf: s.options.map(toJSONSchema), ...meta };
    case "optional":
      return { ...toJSONSchema(s.inner), ...meta };
    case "nullable":
      return { anyOf: [toJSONSchema(s.inner), { type: "null" }], ...meta };
    case "default":
      return { ...toJSONSchema(s.inner), default: s.value, ...meta };
  }
}

function clean(o: JSONSchema): JSONSchema {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
