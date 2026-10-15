// Condition builder: rows of (path, operator, value) <-> the workflows expression syntax
// (`data.record.amount > 10000 && data.record.stage == 'won'`). Only emits what
// @miujs/workflows' compileExpression accepts; anything it cannot read back is "raw mode".
// Self-contained (see filters.ts).

export interface ExprRow {
  /** A path such as data.record.stage. */
  left: string;
  /** == != > >= < <= in contains empty notEmpty changed */
  op: string;
  value: string;
  kind?: "text" | "number" | "boolean";
}

export type ExprLib = ReturnType<typeof exprLib>;

export function exprLib() {
  const PATH = "(?:data|input|steps)(?:\\.[A-Za-z_$][A-Za-z0-9_$-]*|\\.\\d+)*";
  const STR = "'(?:[^'\\\\]|\\\\[\\s\\S])*'";
  const LIT = `(?:${STR}|\\d+(?:\\.\\d+)?|true|false|null)`;
  const PATH_RE = new RegExp(`^${PATH}$`);
  const CMP = ["==", "!=", ">", ">=", "<", "<="];
  const OPS = CMP.concat(["in", "contains", "empty", "notEmpty", "changed"]);

  function quote(s: string): string {
    return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + "'";
  }

  function unquote(s: string): string {
    return s.slice(1, -1).replace(/\\([\s\S])/g, (_m: string, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }

  function literal(value: string, kind: string | undefined): string {
    const v = value.trim();
    if (kind === "number") {
      if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`"${value}" is not a number the expression syntax accepts (digits, optional decimals)`);
      return v;
    }
    if (kind === "boolean") {
      if (v !== "true" && v !== "false") throw new Error(`"${value}" is not true or false`);
      return v;
    }
    return quote(value);
  }

  function checkPath(p: string): string {
    const s = p.trim();
    if (!PATH_RE.test(s)) throw new Error(`"${p}" is not a path; use data.<field>, input.<field> or steps.<id>.output`);
    return s;
  }

  function one(r: ExprRow): string {
    if (OPS.indexOf(r.op) < 0) throw new Error(`Unknown operator "${r.op}"`);
    const left = checkPath(r.left);
    if (r.op === "empty") return `${left} == null`;
    if (r.op === "notEmpty") return `${left} != null`;
    if (r.op === "changed") {
      const m = /^data\.record\.([A-Za-z_$][A-Za-z0-9_$-]*)$/.exec(left);
      if (!m) throw new Error(`"changed" needs a record field path like data.record.stage`);
      return `${quote(m[1])} in data.changes`;
    }
    if (r.op === "contains") return `${literal(r.value, r.kind)} in ${left}`;
    if (r.op === "in") {
      const items = r.value
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== "")
        .map((x) => literal(x, r.kind));
      return `${left} in [${items.join(", ")}]`;
    }
    return `${left} ${r.op} ${literal(r.value, r.kind)}`;
  }

  /** Rows joined with && or ||. Throws an Error with a readable message for a bad row. */
  function build(rows: ExprRow[], join: "&&" | "||"): string {
    return rows.map(one).join(` ${join} `);
  }

  /** Splits on top-level && / || (outside quotes and brackets). */
  function split(src: string): { parts: string[]; joins: string[] } {
    const parts: string[] = [];
    const joins: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"') {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      } else if (c === "[" || c === "(") depth++;
      else if (c === "]" || c === ")") depth--;
      else if (depth === 0 && (src.startsWith("&&", i) || src.startsWith("||", i))) {
        parts.push(src.slice(start, i).trim());
        joins.push(src.slice(i, i + 2));
        start = i + 2;
        i++;
      }
    }
    parts.push(src.slice(start).trim());
    return { parts, joins };
  }

  function readLit(s: string): { value: string; kind: "text" | "number" | "boolean" } | null {
    if (s[0] === "'") return { value: unquote(s), kind: "text" };
    if (s === "true" || s === "false") return { value: s, kind: "boolean" };
    if (/^\d+(\.\d+)?$/.test(s)) return { value: s, kind: "number" };
    return null;
  }

  const RE_CMP = new RegExp(`^(${PATH}) (==|!=|>=|<=|>|<) (${LIT})$`);
  const RE_IN = new RegExp(`^(${PATH}) in \\[((?:${LIT})(?:, (?:${LIT}))*)?\\]$`);
  const RE_CHANGED = new RegExp(`^(${STR}) in data\\.changes$`);
  const RE_CONTAINS = new RegExp(`^(${LIT}) in (${PATH})$`);
  const RE_ITEM = new RegExp(LIT, "g");

  function parseOne(s: string): ExprRow | null {
    let m = RE_CMP.exec(s);
    if (m) {
      if (m[3] === "null") return m[2] === "==" ? { left: m[1], op: "empty", value: "", kind: "text" } : m[2] === "!=" ? { left: m[1], op: "notEmpty", value: "", kind: "text" } : null;
      const lit = readLit(m[3]);
      return lit ? { left: m[1], op: m[2], value: lit.value, kind: lit.kind } : null;
    }
    m = RE_IN.exec(s);
    if (m) {
      const items = (m[2] || "").match(RE_ITEM) || [];
      const lits = items.map(readLit);
      if (lits.some((x) => x === null)) return null;
      const kind = lits.length ? lits[0]!.kind : "text";
      return { left: m[1], op: "in", value: lits.map((x) => x!.value).join(", "), kind };
    }
    m = RE_CHANGED.exec(s);
    if (m) return { left: `data.record.${unquote(m[1])}`, op: "changed", value: "", kind: "text" };
    m = RE_CONTAINS.exec(s);
    if (m) {
      const lit = readLit(m[1]);
      return lit ? { left: m[2], op: "contains", value: lit.value, kind: lit.kind } : null;
    }
    return null;
  }

  /** Rows for the builder, or null when the expression needs raw mode. */
  function parse(src: string): { join: "&&" | "||"; rows: ExprRow[] } | null {
    if (!src || !src.trim()) return { join: "&&", rows: [] };
    const { parts, joins } = split(src.trim());
    if (joins.some((j) => j !== joins[0])) return null;
    const rows: ExprRow[] = [];
    for (const p of parts) {
      const r = parseOne(p);
      if (!r || build([r], "&&") !== p) return null;
      rows.push(r);
    }
    return { join: (joins[0] as "&&" | "||") || "&&", rows };
  }

  return { build, parse, quote, ops: OPS };
}
