// CSV export/import value conversion and the import pipeline (map, validate, check, write).

import { validate, type Issue } from "miujs";
import { csvRow, parseCsv, unguard } from "./csv.ts";
import { adminErrors } from "./errors.ts";
import { currencyDigits, toDb, type FieldDef } from "./fields.ts";
import { Repo, type Prepared } from "./repo.ts";
import { createSchema, writableFields, type AdminRecord, type FieldMetaBase, type Resource } from "./resource.ts";

const NUMERIC = new Set(["number", "money", "percent"]);

/** API value → CSV text. Money is written in major units ("12.50"); lists comma-separated. */
export function toCsvValue(f: FieldDef | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (!f) return v;
  switch (f.type) {
    case "money": {
      const d = currencyDigits(f.options.currency ?? "USD");
      return (Number(v) / 10 ** d).toFixed(d);
    }
    case "tags":
    case "multiSelect":
      return Array.isArray(v) ? v.join(", ") : v;
    case "json":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    default:
      return v;
  }
}

export function exportColumns(r: Resource, fields: string[] | undefined): string[] {
  if (fields && fields.length) return ["id", ...fields.filter((f) => f !== "id")];
  return ["id", ...Object.keys(r.fields), ...(r.timestamps ? ["createdAt", "updatedAt"] : [])];
}

export function exportHeader(columns: string[]): string {
  return csvRow(columns);
}

export function exportLine(r: Resource, columns: string[], rec: AdminRecord): string {
  return csvRow(
    columns.map((c) => toCsvValue(r.fields[c], rec[c])),
    columns.map((c) => NUMERIC.has(r.fields[c]?.type ?? "")),
  );
}

/** CSV text → API value (before schema validation). `undefined` = cell empty. */
function fromCsvValue(f: FieldMetaBase, raw: string): { value?: unknown; error?: string } {
  const s = NUMERIC.has(f.type) ? raw.trim() : unguard(raw);
  if (s.trim() === "") return { value: undefined };
  switch (f.type) {
    case "number":
    case "percent": {
      const n = Number(s.replace(/,/g, ""));
      return Number.isNaN(n) ? { error: `expected a number, got ${JSON.stringify(raw)}` } : { value: n };
    }
    case "money": {
      const d = currencyDigits(f.options.currency ?? "USD");
      const clean = s.replace(/[,\s]/g, "").replace(/^[^\d.-]+/, "");
      if (!/^-?\d+(\.\d+)?$/.test(clean)) return { error: `expected an amount like 12.50, got ${JSON.stringify(raw)}` };
      const [whole, frac = ""] = clean.replace("-", "").split(".");
      if (frac.length > d) return { error: `has more than ${d} decimal places` };
      const minor = Number(whole) * 10 ** d + Number(frac.padEnd(d, "0") || "0");
      return { value: clean.startsWith("-") ? -minor : minor };
    }
    case "boolean": {
      const v = s.trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(v)) return { value: true };
      if (["false", "no", "n", "0"].includes(v)) return { value: false };
      return { error: `expected true/false, got ${JSON.stringify(raw)}` };
    }
    case "tags":
    case "multiSelect":
      return {
        value: s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
    case "json":
      try {
        return { value: JSON.parse(s) };
      } catch {
        return { error: "is not valid JSON" };
      }
    case "select": {
      const v = s.trim();
      const hit = f.options.choices!.find((c) => c.value === v || c.value.toLowerCase() === v.toLowerCase() || (c.label ?? "").toLowerCase() === v.toLowerCase());
      return { value: hit ? hit.value : v };
    }
    case "date":
    case "datetime":
    case "email":
    case "url":
    case "phone":
    case "relation":
    case "user":
    case "file":
      return { value: s.trim() };
    default:
      return { value: s };
  }
}

export interface ImportOptions {
  csv: string;
  /** CSV header → field name; `null` ignores the column. Unlisted headers match field names or labels. */
  mapping?: Record<string, string | null>;
  dryRun?: boolean;
  maxRows: number;
}

export interface RowError {
  /** 1 = the first data row after the header. */
  row: number;
  errors: { field: string; message: string }[];
}

export interface ImportResult {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: number;
  /** Header → field it was mapped to. */
  columns: Record<string, string>;
  ignored: string[];
  errors: RowError[];
  imported?: number;
  ids?: string[];
}

export async function runImport(repo: Repo, rt: { byName: Map<string, Resource> }, o: ImportOptions): Promise<ImportResult> {
  const r = repo.r;
  let rows: string[][];
  try {
    rows = parseCsv(o.csv, o.maxRows + 1);
  } catch (e) {
    if (e instanceof RangeError) throw adminErrors.importTooLarge(o.maxRows);
    throw adminErrors.importInvalid([{ row: 0, errors: [{ field: "", message: (e as Error).message }] }]);
  }
  if (rows.length < 2) throw adminErrors.importEmpty();
  const [header, ...data] = rows;
  const writable = writableFields(r);
  const columns: Record<string, string> = {};
  const ignored: string[] = [];
  const colField: (FieldMetaBase | null)[] = header.map((h) => {
    const key = h.trim();
    let target: string | null | undefined = o.mapping && Object.prototype.hasOwnProperty.call(o.mapping, key) ? o.mapping[key] : undefined;
    if (target === undefined) {
      const lower = key.toLowerCase();
      target = writable.find((f) => f.name.toLowerCase() === lower || f.label.toLowerCase() === lower || f.column === lower)?.name ?? null;
    }
    const f = target ? writable.find((x) => x.name === target) : undefined;
    if (!f) {
      ignored.push(key);
      return null;
    }
    columns[key] = f.name;
    return f;
  });
  for (const [h, target] of Object.entries(o.mapping ?? {})) {
    if (target !== null && !writable.some((f) => f.name === target)) {
      throw adminErrors.importInvalid([{ row: 0, errors: [{ field: target, message: `mapping "${h}" → "${target}": not a writable field` }] }]);
    }
  }

  const schema = createSchema(r);
  const errors: RowError[] = [];
  const values: (Record<string, unknown> | null)[] = [];
  // Relations may be given by id or by the target's title (e.g. the company name).
  const relationCache = new Map<string, Map<string, string | null>>();
  const resolveRelation = async (f: FieldMetaBase, v: string): Promise<string | null> => {
    let cache = relationCache.get(f.name);
    if (!cache) relationCache.set(f.name, (cache = new Map()));
    if (cache.has(v)) return cache.get(v)!;
    const target = rt.byName.get(f.options.target!)!;
    const targetRepo = repo.sibling(target);
    let id: string | null = (await targetRepo.findRow(v)) ? v : null;
    if (id === null && target.titleField !== "id") {
      const page = await targetRepo.list({ filter: { [target.titleField]: { eq: v } }, limit: 2 });
      if (page.items.length === 1) id = page.items[0].id;
    }
    cache.set(v, id);
    return id;
  };
  const seenUnique = new Map<string, Map<string, number>>();
  // Uniqueness against existing records is checked after the loop, in batches of 50 values.
  const uniqueChecks: { rowNo: number; f: FieldMetaBase; v: unknown; key: string; errors: { field: string; message: string }[] }[] = [];
  const pending: { rowNo: number; value: Record<string, unknown>; errors: { field: string; message: string }[] }[] = [];
  for (let i = 0; i < data.length; i++) {
    const rowNo = i + 1;
    const cells = data[i];
    const rowErrors: { field: string; message: string }[] = [];
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < colField.length; c++) {
      const f = colField[c];
      if (!f) continue;
      const conv = fromCsvValue(f, cells[c] ?? "");
      if (conv.error) rowErrors.push({ field: f.name, message: conv.error });
      else if (conv.value !== undefined) obj[f.name] = conv.value;
    }
    const checked = validate(schema, obj);
    if (!checked.ok) {
      for (const issue of checked.issues as Issue[]) {
        const field = issue.path.split(".")[0] || "";
        if (!rowErrors.some((e) => e.field === field)) rowErrors.push({ field, message: issue.message });
      }
    }
    // Relations and uniqueness are checked for every cell that is valid on its own, so one
    // dry run lists all of a row's problems.
    const value = (checked.ok ? checked.value : obj) as Record<string, unknown>;
    for (const f of Object.values(r.fields)) {
      const v = value[f.name];
      if (v === undefined || v === null || rowErrors.some((e) => e.field === f.name)) continue;
      if (f.type === "relation") {
        const id = await resolveRelation(f, String(v));
        if (id === null) rowErrors.push({ field: f.name, message: `no ${f.options.target} with id or ${rt.byName.get(f.options.target!)!.titleField} ${JSON.stringify(v)}` });
        else value[f.name] = id;
      }
      if (f.options.unique) {
        const key = JSON.stringify(toDb(f, v));
        let seen = seenUnique.get(f.name);
        if (!seen) seenUnique.set(f.name, (seen = new Map()));
        const prev = seen.get(key);
        if (prev !== undefined) rowErrors.push({ field: f.name, message: `duplicate of row ${prev}` });
        else {
          seen.set(key, rowNo);
          uniqueChecks.push({ rowNo, f, v, key, errors: rowErrors });
        }
      }
    }
    pending.push({ rowNo, value, errors: rowErrors });
  }
  const byField = new Map<FieldMetaBase, typeof uniqueChecks>();
  for (const u of uniqueChecks) {
    let list = byField.get(u.f);
    if (!list) byField.set(u.f, (list = []));
    list.push(u);
  }
  for (const [f, list] of byField) {
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      const existing = await repo.list({ filter: { [f.name]: { in: chunk.map((u) => u.v) } }, limit: chunk.length });
      const taken = new Map(existing.items.map((rec) => [JSON.stringify(toDb(f, rec[f.name])), rec.id]));
      for (const u of chunk) {
        const id = taken.get(u.key);
        if (id !== undefined) u.errors.push({ field: f.name, message: `already used by ${r.singular.toLowerCase()} ${id}` });
      }
    }
  }
  for (const p of pending) {
    if (p.errors.length) errors.push({ row: p.rowNo, errors: p.errors });
    values.push(p.errors.length ? null : p.value);
  }
  const result: ImportResult = { dryRun: !!o.dryRun, total: data.length, valid: data.length - errors.length, invalid: errors.length, columns, ignored, errors };
  if (o.dryRun) return result;
  if (errors.length) throw adminErrors.importInvalid(errors);
  const prepared: (Prepared & { id: string })[] = [];
  for (const v of values) prepared.push(await repo.prepareCreate(v!));
  await repo.run(prepared);
  result.imported = prepared.length;
  result.ids = prepared.map((p) => p.id);
  return result;
}

