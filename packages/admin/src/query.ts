// List queries: filters → SQL, single-field sort with keyset (cursor) pagination, search.
// Every value is bound; identifiers only come from the resource definition.

import { quoteIdent } from "@miujs/db";
import { validate } from "miujs";
import { adminErrors } from "./errors.ts";
import { isValidDate, operatorsFor, toDb, valueSchema, type FieldDef, type FieldType } from "./fields.ts";
import { FILTER_OPS, QUERY_KEYS, sortableKeys, type Filter, type Resource } from "./resource.ts";
import { ftsTable, searchColumns } from "./tables.ts";

export interface Clause {
  sql: string;
  binds: unknown[];
}

interface Column {
  key: string;
  column: string;
  def: FieldDef;
}

const SYSTEM: Record<string, FieldType> = { id: "text", createdAt: "datetime", updatedAt: "datetime", createdBy: "user", updatedBy: "user" };
const SYSTEM_COLUMNS: Record<string, string> = { id: "id", createdAt: "created_at", updatedAt: "updated_at", createdBy: "created_by", updatedBy: "updated_by" };

/** A filterable/sortable column by API key, including system fields. */
export function columnOf(r: Resource, key: string): Column | null {
  const f = Object.prototype.hasOwnProperty.call(r.fields, key) ? r.fields[key] : undefined;
  if (f) return { key, column: f.column, def: f };
  if (!Object.prototype.hasOwnProperty.call(SYSTEM, key)) return null;
  if (key !== "id" && !r.timestamps) return null;
  return { key, column: SYSTEM_COLUMNS[key], def: { kind: "miu.admin.field", type: SYSTEM[key], options: {} } };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `"today"`, `"today+7d"`, `"now-1d"` → a date string or ISO time; anything else unchanged. */
export function resolveRelative(type: FieldType, v: unknown, now: number): unknown {
  if (typeof v !== "string") return v;
  const m = /^(today|now)(?:([+-])(\d{1,4})d)?$/.exec(v);
  if (!m) return v;
  const shift = m[2] ? (m[2] === "-" ? -1 : 1) * Number(m[3]) * 86_400_000 : 0;
  const at = now + shift;
  if (type === "date") return utcDay(at);
  if (m[1] === "today") return new Date(`${utcDay(at)}T00:00:00.000Z`).toISOString();
  return new Date(at).toISOString();
}

/** One filter value → its SQL value, or an error message. */
function filterValue(c: Column, op: string, raw: unknown, now: number): { ok: true; value: unknown } | { ok: false; message: string } {
  const type = c.def.type;
  let v = resolveRelative(type, raw, now);
  if (op === "contains") {
    if (typeof v !== "string" || v === "") return { ok: false, message: `${c.key}.contains needs a non-empty string` };
    return { ok: true, value: v };
  }
  // Query strings arrive as text: coerce numbers and booleans.
  if (typeof v === "string" && (type === "number" || type === "money" || type === "percent")) {
    const n = Number(v);
    if (v.trim() === "" || Number.isNaN(n)) return { ok: false, message: `${c.key}.${op} needs a number, got ${JSON.stringify(v)}` };
    v = n;
  }
  if (typeof v === "string" && type === "boolean") {
    if (v === "true" || v === "1") v = true;
    else if (v === "false" || v === "0") v = false;
  }
  if (type === "date") {
    if (typeof v !== "string" || !isValidDate(v)) return { ok: false, message: `${c.key}.${op} needs a date (YYYY-MM-DD, "today", "today+7d"), got ${JSON.stringify(raw)}` };
    return { ok: true, value: v };
  }
  if (type === "datetime") {
    const ms = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isNaN(ms)) return { ok: false, message: `${c.key}.${op} needs an ISO date-time (or "now", "today-1d"), got ${JSON.stringify(raw)}` };
    return { ok: true, value: ms };
  }
  // Range comparisons on text are allowed (alphabetical) without format checks.
  const base = ["select", "relation", "user", "file", "number", "money", "percent", "boolean"].includes(type) || op === "eq" || op === "ne" || op === "in" ? valueSchema(c.def) : null;
  if (base && !(type === "email" || type === "url" || type === "phone" || type === "file")) {
    const r = validate(base, v);
    if (!r.ok) return { ok: false, message: `${c.key}.${op}: ${r.issues[0].message}` };
    return { ok: true, value: toDb(c.def, r.value) };
  }
  if (typeof v !== "string" && typeof v !== "number") return { ok: false, message: `${c.key}.${op} needs a string, got ${JSON.stringify(raw)}` };
  return { ok: true, value: v };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * `{ stage: "lead", value: { gte: 100 }, tags: { contains: "vip" } }` → SQL clauses (ANDed).
 * `ne` matches NULLs too ("not lead" includes records with no stage).
 */
export function filterClauses(r: Resource, filter: Filter, now: number = Date.now()): Clause[] {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) throw adminErrors.filterInvalid("expected an object");
  const out: Clause[] = [];
  for (const [key, spec] of Object.entries(filter)) {
    const c = columnOf(r, key);
    if (!c) throw adminErrors.filterInvalid(`unknown field "${key}"`, { field: key });
    const col = quoteIdent(c.column);
    const ops = typeof spec === "object" && spec !== null && !Array.isArray(spec) ? (spec as Record<string, unknown>) : { eq: spec };
    const allowed = c.key in SYSTEM ? (c.key === "id" ? ["eq", "ne", "in"] : operatorsFor(c.def)) : operatorsFor(c.def);
    for (const [op, raw] of Object.entries(ops)) {
      if (!FILTER_OPS.includes(op as never)) throw adminErrors.filterInvalid(`unknown operator "${op}" on "${key}"`, { field: key, op });
      if (!allowed.includes(op)) throw adminErrors.filterInvalid(`"${key}" (${c.def.type}) does not support "${op}"; use ${allowed.join(", ")}`, { field: key, op });
      if (op === "isNull") {
        const want = raw === true || raw === "true" || raw === "1" ? true : raw === false || raw === "false" || raw === "0" ? false : null;
        if (want === null) throw adminErrors.filterInvalid(`${key}.isNull needs true or false`, { field: key, op });
        const json = c.def.type === "tags" || c.def.type === "multiSelect";
        out.push({ sql: want ? (json ? `(${col} IS NULL OR ${col} = '[]')` : `${col} IS NULL`) : json ? `(${col} IS NOT NULL AND ${col} != '[]')` : `${col} IS NOT NULL`, binds: [] });
        continue;
      }
      if (raw === null || raw === undefined) {
        if (op === "eq") out.push({ sql: `${col} IS NULL`, binds: [] });
        else if (op === "ne") out.push({ sql: `${col} IS NOT NULL`, binds: [] });
        else throw adminErrors.filterInvalid(`${key}.${op} needs a value`, { field: key, op });
        continue;
      }
      if (op === "in") {
        const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").filter((s) => s !== "") : null;
        if (!list || list.length === 0 || list.length > 50) throw adminErrors.filterInvalid(`${key}.in needs a list of 1-50 values`, { field: key, op });
        const values = list.map((x) => {
          const fv = filterValue(c, "in", x, now);
          if (!fv.ok) throw adminErrors.filterInvalid(fv.message, { field: key, op });
          return fv.value;
        });
        out.push({ sql: `${col} IN (${values.map(() => "?").join(", ")})`, binds: values });
        continue;
      }
      const fv = filterValue(c, op, raw, now);
      if (!fv.ok) throw adminErrors.filterInvalid(fv.message, { field: key, op });
      const value = fv.value;
      switch (op) {
        case "eq":
          out.push({ sql: `${col} = ?`, binds: [value] });
          break;
        case "ne":
          out.push({ sql: `(${col} IS NULL OR ${col} != ?)`, binds: [value] });
          break;
        case "gt":
          out.push({ sql: `${col} > ?`, binds: [value] });
          break;
        case "gte":
          out.push({ sql: `${col} >= ?`, binds: [value] });
          break;
        case "lt":
          out.push({ sql: `${col} < ?`, binds: [value] });
          break;
        case "lte":
          out.push({ sql: `${col} <= ?`, binds: [value] });
          break;
        case "contains":
          if (c.def.type === "tags" || c.def.type === "multiSelect") {
            out.push({ sql: `EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value = ?)`, binds: [value] });
          } else {
            out.push({ sql: `${col} LIKE ? ESCAPE '\\'`, binds: [`%${escapeLike(String(value))}%`] });
          }
          break;
      }
    }
  }
  return out;
}

/** Query-string filters from the validated query: `?stage=lead` (eq) and `?value[gte]=1000`. */
export function queryFilter(r: Resource, query: Record<string, unknown>): Filter {
  const out: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || QUERY_KEYS.includes(k)) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*)\[([A-Za-z]+)\]$/.exec(k);
    if (m) {
      if (!columnOf(r, m[1])) throw adminErrors.filterInvalid(`unknown field "${m[1]}"`, { field: m[1] });
      (out[m[1]] ??= Object.create(null))[m[2]] = v;
    } else if (Object.prototype.hasOwnProperty.call(r.fields, k)) {
      (out[k] ??= Object.create(null)).eq = v;
    }
  }
  return out;
}

/** Merges filters; both apply (AND). Same field+op: the later one wins. */
export function mergeFilters(...filters: (Filter | undefined)[]): Filter {
  // Null prototype: a "__proto__" key stays a (rejected) field name instead of a prototype.
  const out: Record<string, Record<string, unknown>> = Object.create(null);
  for (const f of filters) {
    if (!f) continue;
    for (const [k, spec] of Object.entries(f)) {
      const ops = typeof spec === "object" && spec !== null && !Array.isArray(spec) ? (spec as Record<string, unknown>) : { eq: spec };
      out[k] = Object.assign(Object.create(null), out[k], ops);
    }
  }
  return out;
}

export interface Sort {
  key: string;
  column: string;
  desc: boolean;
  /** The column is NOT NULL in every table (createdAt, updatedAt), so plain index-friendly SQL works. */
  notNull?: boolean;
}

export function parseSort(r: Resource, sort: string | undefined): Sort {
  const s = sort ?? r.defaultSort;
  const desc = s.startsWith("-");
  const key = desc ? s.slice(1) : s;
  const allowed = sortableKeys(r);
  const c = allowed.includes(key) ? columnOf(r, key) : null;
  if (!c) throw adminErrors.sortInvalid(s, allowed);
  // Required fields are NOT NULL columns too.
  return { key, column: c.column, desc, notNull: key === "createdAt" || key === "updatedAt" || !!c.def.options.required };
}

interface Cursor {
  s: string;
  v: unknown;
  id: string;
}

function b64url(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCursor(sort: Sort, row: Record<string, unknown>): string {
  return b64url(JSON.stringify({ s: `${sort.desc ? "-" : ""}${sort.key}`, v: sort.column === "id" ? null : (row[sort.column] ?? null), id: row.id }));
}

export function decodeCursor(sort: Sort, raw: string): Cursor {
  let c: Cursor;
  try {
    c = JSON.parse(unb64url(raw));
  } catch {
    throw adminErrors.cursorInvalid();
  }
  const ok = c && typeof c === "object" && c.s === `${sort.desc ? "-" : ""}${sort.key}` && typeof c.id === "string" && (c.v === null || typeof c.v === "string" || typeof c.v === "number");
  if (!ok) throw adminErrors.cursorInvalid();
  return c;
}

/**
 * ORDER BY with NULLs last in both directions and the id as tiebreaker, plus the keyset clause
 * for "rows after this cursor".
 */
export function sortSql(sort: Sort, cursor: string | undefined): { orderBy: string; after: Clause | null } {
  const col = quoteIdent(sort.column);
  const dir = sort.desc ? "DESC" : "ASC";
  const cmp = sort.desc ? "<" : ">";
  if (sort.column === "id") {
    const after = cursor ? { sql: `"id" ${cmp} ?`, binds: [decodeCursor(sort, cursor).id] } : null;
    return { orderBy: `"id" ${dir}`, after };
  }
  if (sort.notNull) {
    // No NULLs to place: ORDER BY and the keyset range can use the (org_id, created_at) index,
    // so each page is a range read instead of a sort of every matching row.
    const orderBy = `${col} ${dir}, "id" ${dir}`;
    if (!cursor) return { orderBy, after: null };
    const c = decodeCursor(sort, cursor);
    if (c.v === null) return { orderBy, after: { sql: `"id" ${cmp} ?`, binds: [c.id] } };
    return { orderBy, after: { sql: `(${col} ${cmp}= ? AND (${col} ${cmp} ? OR "id" ${cmp} ?))`, binds: [c.v, c.v, c.id] } };
  }
  const orderBy = `(${col} IS NULL) ASC, ${col} ${dir}, "id" ${dir}`;
  if (!cursor) return { orderBy, after: null };
  const c = decodeCursor(sort, cursor);
  if (c.v === null) return { orderBy, after: { sql: `(${col} IS NULL AND "id" ${cmp} ?)`, binds: [c.id] } };
  return {
    orderBy,
    after: { sql: `((${col} IS NOT NULL AND (${col} ${cmp} ? OR (${col} = ? AND "id" ${cmp} ?))) OR ${col} IS NULL)`, binds: [c.v, c.v, c.id] },
  };
}

/**
 * A nullable sort as two index-friendly parts instead of one ORDER BY over `(col IS NULL)`, which
 * no index can serve: first the rows with a value, `ORDER BY col, id` with a keyset range (an
 * (org, col, id) index reads just one page), then, once those run out, the NULL rows by id. Same
 * order and cursors as sortSql: values first, NULLs last, in both directions.
 */
export function splitSort(sort: Sort, cursor: string | undefined): { values: { orderBy: string; where: Clause } | null; nulls: { orderBy: string; where: Clause } } {
  const col = quoteIdent(sort.column);
  const dir = sort.desc ? "DESC" : "ASC";
  const cmp = sort.desc ? "<" : ">";
  const c = cursor ? decodeCursor(sort, cursor) : null;
  const nullsOrder = `"id" ${dir}`;
  if (c && c.v === null) return { values: null, nulls: { orderBy: nullsOrder, where: { sql: `${col} IS NULL AND "id" ${cmp} ?`, binds: [c.id] } } };
  const values = c
    ? { sql: `(${col} ${cmp}= ? AND (${col} ${cmp} ? OR "id" ${cmp} ?))`, binds: [c.v, c.v, c.id] }
    : { sql: `${col} IS NOT NULL`, binds: [] };
  return { values: { orderBy: `${col} ${dir}, "id" ${dir}`, where: values }, nulls: { orderBy: nullsOrder, where: { sql: `${col} IS NULL`, binds: [] } } };
}

/** Free-text search: FTS5 when `search: true`, else LIKE over searchable (or title) fields. */
export function searchClause(r: Resource, q: string | undefined): Clause | null {
  if (q === undefined) return null;
  const tokens = q
    .split(/\s+/)
    .map((s) => s.replace(/"/g, ""))
    .filter((s) => /[\p{L}\p{N}]/u.test(s))
    .slice(0, 12);
  if (tokens.length === 0) return null;
  if (r.search) {
    const match = tokens.map((tk) => `"${tk}"*`).join(" ");
    return { sql: `"id" IN (SELECT "id" FROM ${quoteIdent(ftsTable(r))} WHERE ${quoteIdent(ftsTable(r))} MATCH ?)`, binds: [match] };
  }
  const cols = searchColumns(r);
  const columns = cols.length ? cols : r.titleField !== "id" ? [r.fields[r.titleField].column] : ["id"];
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const tk of tokens) {
    parts.push(`(${columns.map((c) => `${quoteIdent(c)} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    for (const _ of columns) binds.push(`%${escapeLike(tk)}%`);
  }
  return { sql: parts.join(" AND "), binds };
}
