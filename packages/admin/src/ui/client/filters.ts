// Filter builder logic: field + operator + value rows <-> the list API's filter JSON.
//
// Client modules are self-contained factory functions: no imports and no references outside
// the function body, so the server can ship them to the browser as `(${fn})()` without a
// bundler, and tests call them directly. Types below are erased.

export interface FilterField {
  name: string;
  type: string;
  label: string;
  operators: string[];
  options?: { value: string; label: string }[];
  currencyDigits?: number;
  integer?: boolean;
}

export interface FilterRow {
  field: string;
  op: string;
  value: string;
}

export interface ValueInput {
  kind: "text" | "number" | "date" | "datetime-local" | "select" | "boolean";
  step?: string;
  options?: { value: string; label: string }[];
  hint?: string;
}

export interface ListState {
  filter?: Record<string, unknown>;
  q?: string;
  sort?: string;
  view?: string;
  cursor?: string;
}

export type FilterLib = ReturnType<typeof filterLib>;

export function filterLib() {
  const LABELS: Record<string, string> = {
    eq: "is",
    ne: "is not",
    gt: ">",
    gte: "≥",
    lt: "<",
    lte: "≤",
    in: "is one of",
    contains: "contains",
    isNull: "is empty",
  };
  const NUMERIC = ["number", "money", "percent"];
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const byName = (fields: FilterField[], name: string) => fields.find((f) => f.name === name);

  function operators(f: FilterField): { op: string; label: string }[] {
    return f.operators.map((op) => ({ op, label: LABELS[op] || op }));
  }

  function valueInput(f: FilterField, op: string): ValueInput {
    if (op === "isNull" || f.type === "boolean") return { kind: "boolean" };
    if (op === "in") return { kind: "text", hint: "comma-separated" };
    if (f.type === "money") return { kind: "number", step: String(1 / Math.pow(10, f.currencyDigits ?? 2)) };
    if (f.type === "number") return { kind: "number", step: f.integer ? "1" : "any" };
    if (f.type === "percent") return { kind: "number", step: "any" };
    if (f.type === "date") return { kind: "date" };
    if (f.type === "datetime") return { kind: "datetime-local" };
    if ((f.type === "select" || f.type === "multiSelect") && f.options && op !== "contains") {
      return { kind: "select", options: f.options.map((o) => ({ value: o.value, label: o.label })) };
    }
    return { kind: "text" };
  }

  /** One scalar from the text box to the API value. Throws a message string when invalid. */
  function scalar(f: FilterField, raw: string): unknown {
    const s = raw.trim();
    if (NUMERIC.indexOf(f.type) >= 0) {
      const n = Number(s.replace(/,/g, ""));
      if (s === "" || !isFinite(n)) throw `${f.label}: expected a number, got "${raw}"`;
      return f.type === "money" ? Math.round(n * Math.pow(10, f.currencyDigits ?? 2)) : n;
    }
    if (f.type === "boolean") {
      if (s !== "true" && s !== "false") throw `${f.label}: expected true or false`;
      return s === "true";
    }
    if (f.type === "datetime" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      return new Date(s + (s.length === 16 ? ":00" : "") + "Z").toISOString();
    }
    return s;
  }

  /** Rows from the builder → `{ field: { op: value } }`. Invalid rows are reported and skipped. */
  function rowsToFilter(rows: FilterRow[], fields: FilterField[]): { filter: Record<string, Record<string, unknown>>; errors: { index: number; message: string }[] } {
    const filter: Record<string, Record<string, unknown>> = {};
    const errors: { index: number; message: string }[] = [];
    rows.forEach((row, index) => {
      const f = byName(fields, row.field);
      if (!f || row.field === "__proto__") return errors.push({ index, message: `Unknown field "${row.field}"` });
      if (f.operators.indexOf(row.op) < 0) return errors.push({ index, message: `${f.label} cannot be filtered with "${row.op}"` });
      const raw = row.value == null ? "" : String(row.value);
      if (raw.trim() === "") return; // an empty row is ignored, not an error
      let value: unknown;
      try {
        if (row.op === "isNull") {
          if (raw !== "true" && raw !== "false") throw `${f.label}: choose yes or no`;
          value = raw === "true";
        } else if (row.op === "in") {
          value = raw
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x !== "")
            .map((x) => scalar(f, x));
        } else value = scalar(f, raw);
      } catch (msg) {
        return errors.push({ index, message: String(msg) });
      }
      if (!own(filter, f.name)) filter[f.name] = {};
      filter[f.name][row.op] = value;
    });
    return { filter, errors };
  }

  function display(f: FilterField, v: unknown): string {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map((x) => display(f, x)).join(", ");
    if (f.type === "money" && typeof v === "number") {
      const d = f.currencyDigits ?? 2;
      return (v / Math.pow(10, d)).toFixed(d);
    }
    if (f.type === "datetime" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16);
    return String(v);
  }

  /** Filter JSON (from the URL) → rows for the builder. Unknown fields and operators are dropped. */
  function filterToRows(filter: unknown, fields: FilterField[]): FilterRow[] {
    const rows: FilterRow[] = [];
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) return rows;
    for (const name of Object.keys(filter)) {
      const f = byName(fields, name);
      if (!f) continue;
      const cond = (filter as Record<string, unknown>)[name];
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        for (const op of Object.keys(cond)) {
          if (f.operators.indexOf(op) < 0) continue;
          rows.push({ field: name, op, value: display(f, (cond as Record<string, unknown>)[op]) });
        }
      } else if (f.operators.indexOf("eq") >= 0) rows.push({ field: name, op: "eq", value: display(f, cond) });
    }
    return rows;
  }

  /** The list page URL query for a state. Cursors are dropped: a new filter starts at page one. */
  function toQuery(s: ListState): string {
    const p = new URLSearchParams();
    if (s.view) p.set("view", s.view);
    if (s.filter && Object.keys(s.filter).length) p.set("filter", JSON.stringify(s.filter));
    if (s.q) p.set("q", s.q);
    if (s.sort) p.set("sort", s.sort);
    return p.toString();
  }

  return { operators, valueInput, rowsToFilter, filterToRows, toQuery, display };
}
