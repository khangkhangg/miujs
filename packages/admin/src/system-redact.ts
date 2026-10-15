// Which values of settings and action inputs are secrets. The schema decides: a string field is
// a secret when its schema opts in (`format: "password"`, `writeOnly: true` or `"x-secret": true`)
// or, failing that, when its name looks secret (password, secret, token, apiKey, …Key).
// Numbers, booleans, enums, literals and dates are never secrets, so `minPasswordLength` or
// `maxTokens` stay visible. Keys the schema does not describe fall back to the name rule for
// string values only.

import { redactor } from "@miujs/audit";

export const REDACTED = "[REDACTED]";

const nameLooksSecret = redactor([/(?:^|[_-])(?:key|KEY)$|[a-z0-9]Key$/]);

type Json = Record<string, unknown>;
const obj = (s: unknown): Json | null => (s && typeof s === "object" && !Array.isArray(s) ? (s as Json) : null);
const alternatives = (s: Json): Json[] => (Array.isArray(s.anyOf) ? (s.anyOf as unknown[]) : Array.isArray(s.oneOf) ? (s.oneOf as unknown[]) : []).map(obj).filter((x): x is Json => !!x);

/** Opted in explicitly by the schema (or by one alternative of a union / nullable). */
function optedIn(s: Json): boolean {
  if (s.format === "password" || s.writeOnly === true || s["x-secret"] === true) return true;
  return alternatives(s).some(optedIn);
}

/** A free-form string: not an enum, a constant or a date. */
function isFreeString(s: Json): boolean {
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes("string") && s.enum === undefined && s.const === undefined && s.format !== "date" && s.format !== "date-time") return true;
  return alternatives(s).some(isFreeString);
}

/** Is the field `key` (described by `schema`, or undefined when no schema covers it) a secret? */
export function isSecretField(key: string, schema: unknown, value?: unknown): boolean {
  const s = obj(schema);
  if (!s) return typeof value === "string" && nameLooksSecret(key);
  if (optedIn(s)) return true;
  return isFreeString(s) && nameLooksSecret(key);
}

/** The sub-schema for an object's property, or undefined. */
function propertySchema(s: Json | null, key: string): unknown {
  if (!s) return undefined;
  const props = obj(s.properties);
  if (props && Object.prototype.hasOwnProperty.call(props, key)) return props[key];
  if (obj(s.additionalProperties)) return s.additionalProperties;
  for (const alt of alternatives(s)) {
    const found = propertySchema(alt, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function itemSchema(s: Json | null): unknown {
  if (!s) return undefined;
  if (obj(s.items)) return s.items;
  for (const alt of alternatives(s)) {
    const found = itemSchema(alt);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Deep copy of `value` with every secret field (per `schema`, a JSON schema) set to "[REDACTED]". */
export function redactBySchema(value: unknown, schema: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const s = obj(schema);
  if (Array.isArray(value)) {
    const item = itemSchema(s);
    return value.map((v) => redactBySchema(v, item));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const ps = propertySchema(s, k);
    out[k] = v !== null && v !== undefined && isSecretField(k, ps, v) ? REDACTED : redactBySchema(v, ps);
  }
  return out;
}

/** Top-level fields of a settings object that are secrets, by schema. */
export function secretKeys(value: unknown, schema: unknown): string[] {
  const o = obj(value);
  if (!o) return [];
  return Object.keys(o).filter((k) => isSecretField(k, propertySchema(obj(schema), k), o[k]));
}
