// A tiny, safe expression language for JSON-defined workflows. Parsed into closures once; no
// `eval`/`new Function` (Cloudflare Workers forbid them), no calls, no assignment, and paths
// only ever read own properties, so `constructor`/`__proto__` lead nowhere.

import { workflowErrors } from "./errors.ts";

export type Scope = Record<string, unknown>;

export interface CompiledExpression {
  readonly source: string;
  /** Every path the expression reads, as segments (e.g. ["steps", "enrich", "output"]). */
  readonly paths: string[][];
  evaluate(scope: Scope): unknown;
}

export interface CompileOptions {
  /** Names a path may start with. Default: data, input, steps. */
  roots?: string[];
}

type Tok =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const OPS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "(", ")", "[", "]", ",", "."];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i++;
      let s = "";
      for (;;) {
        if (i >= src.length) throw workflowErrors.expression(src, "Unterminated string", start);
        const d = src[i++];
        if (d === c) break;
        if (d === "\\") {
          if (i >= src.length) throw workflowErrors.expression(src, "Unterminated string", start);
          const e = src[i++];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else s += d;
      }
      out.push({ t: "str", v: s, at: start });
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw workflowErrors.expression(src, `Unexpected ${JSON.stringify(c)}`, i);
    out.push({ t: "op", v: op, at: i });
    i += op.length;
  }
  out.push({ t: "end", at: src.length });
  return out;
}

type Fn = (scope: Scope) => unknown;

function own(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) {
    if (key === "length") return obj.length;
    return /^\d+$/.test(key) ? obj[Number(key)] : undefined;
  }
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

function eq(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}

function ordered(a: unknown, b: unknown): boolean {
  return (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
}

function contains(hay: unknown, needle: unknown): boolean {
  if (Array.isArray(hay)) return hay.some((x) => eq(x, needle));
  if (typeof hay === "string") return typeof needle === "string" && hay.includes(needle);
  if (hay !== null && typeof hay === "object") return typeof needle === "string" && Object.prototype.hasOwnProperty.call(hay, needle);
  return false;
}

const COMPARE: Record<string, (a: unknown, b: unknown) => boolean> = {
  "==": eq,
  "!=": (a, b) => !eq(a, b),
  ">": (a, b) => ordered(a, b) && (a as number) > (b as number),
  ">=": (a, b) => ordered(a, b) && (a as number) >= (b as number),
  "<": (a, b) => ordered(a, b) && (a as number) < (b as number),
  "<=": (a, b) => ordered(a, b) && (a as number) <= (b as number),
  in: (a, b) => contains(b, a),
};

const cache = new Map<string, CompiledExpression>();

/** Parse `source` once. Throws MIU_E_WORKFLOW_EXPRESSION for anything outside the language. */
export function compileExpression(source: string, opts: CompileOptions = {}): CompiledExpression {
  const roots = opts.roots ?? ["data", "input", "steps"];
  const key = roots.join(",") + "\u0000" + source;
  const hit = cache.get(key);
  if (hit) return hit;

  if (typeof source !== "string" || source.trim() === "") throw workflowErrors.expression(String(source), "expression is empty");
  const toks = tokenize(source);
  let p = 0;
  const paths: string[][] = [];
  const peek = () => toks[p];
  const isOp = (v: string) => {
    const tk = toks[p];
    return tk.t === "op" && tk.v === v;
  };
  const unexpected = (tk: Tok): never =>
    throw_(workflowErrors.expression(source, tk.t === "end" ? "Unexpected end of expression" : `Unexpected ${JSON.stringify(tk.t === "num" || tk.t === "str" ? tk.v : tk.v)}`, tk.at));

  const parseOr = (): Fn => {
    let left = parseAnd();
    while (isOp("||")) {
      p++;
      const l = left;
      const r = parseAnd();
      left = (s) => Boolean(l(s)) || Boolean(r(s));
    }
    return left;
  };
  const parseAnd = (): Fn => {
    let left = parseCmp();
    while (isOp("&&")) {
      p++;
      const l = left;
      const r = parseCmp();
      left = (s) => Boolean(l(s)) && Boolean(r(s));
    }
    return left;
  };
  const parseCmp = (): Fn => {
    const left = parseUnary();
    const tk = peek();
    const op = tk.t === "op" && COMPARE[tk.v] ? tk.v : tk.t === "id" && tk.v === "in" ? "in" : null;
    if (!op) return left;
    p++;
    const right = parseUnary();
    const f = COMPARE[op];
    return (s) => f(left(s), right(s));
  };
  const parseUnary = (): Fn => {
    if (isOp("!")) {
      p++;
      const inner = parseUnary();
      return (s) => !inner(s);
    }
    return parsePrimary();
  };
  const parsePrimary = (): Fn => {
    const tk = toks[p++];
    if (tk.t === "num" || tk.t === "str") {
      const v = tk.v;
      return () => v;
    }
    if (tk.t === "op" && tk.v === "(") {
      const inner = parseOr();
      if (!isOp(")")) throw workflowErrors.expression(source, "Expected )", peek().at);
      p++;
      return inner;
    }
    if (tk.t === "op" && tk.v === "[") {
      const items: Fn[] = [];
      if (!isOp("]")) {
        for (;;) {
          items.push(parseOr());
          if (isOp(",")) {
            p++;
            continue;
          }
          break;
        }
      }
      if (!isOp("]")) throw workflowErrors.expression(source, "Expected ]", peek().at);
      p++;
      return (s) => items.map((f) => f(s));
    }
    if (tk.t === "id") {
      if (tk.v === "true") return () => true;
      if (tk.v === "false") return () => false;
      if (tk.v === "null") return () => null;
      if (!roots.includes(tk.v)) {
        throw workflowErrors.expression(source, `Unknown name "${tk.v}"; paths start with ${roots.map((r) => `${r}.`).join(", ")}`, tk.at);
      }
      const segs = [tk.v];
      while (isOp(".")) {
        p++;
        const s = toks[p++];
        if (s.t === "id") segs.push(s.v);
        else if (s.t === "num" && Number.isInteger(s.v)) segs.push(String(s.v));
        else unexpected(s);
      }
      paths.push(segs);
      return (scope) => {
        let v: unknown = own(scope, segs[0]);
        for (let i = 1; i < segs.length && v !== undefined; i++) v = own(v, segs[i]);
        return v;
      };
    }
    return unexpected(tk);
  };

  const fn = parseOr();
  if (peek().t !== "end") unexpected(peek());
  const compiled: CompiledExpression = { source, paths, evaluate: (scope) => fn(scope) };
  if (cache.size > 1000) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

function throw_(e: unknown): never {
  throw e;
}

/** Compile and evaluate in one go. */
export function evaluate(source: string, scope: Scope, opts?: CompileOptions): unknown {
  return compileExpression(source, opts).evaluate(scope);
}

const WHOLE = /^\{\{\s*([\s\S]*?)\s*\}\}$/;
const PART = /\{\{\s*([\s\S]*?)\s*\}\}/g;

/** Expressions inside `{{ }}` in `value`'s strings (deeply), for validation. */
export function templateExpressions(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(PART)].map((m) => m[1]);
  if (Array.isArray(value)) return value.flatMap(templateExpressions);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(templateExpressions);
  return [];
}

export function hasTemplate(value: unknown): boolean {
  return typeof value === "string" && value.includes("{{");
}

/**
 * Replace `{{ expr }}` in strings (deeply through arrays and objects). A string that is exactly
 * one template keeps the value's type; otherwise values are stringified (null/undefined → "").
 */
export function interpolate(value: unknown, scope: Scope, opts?: CompileOptions): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const whole = WHOLE.exec(value);
    if (whole && !whole[1].includes("{{")) return evaluate(whole[1], scope, opts);
    return value.replace(PART, (_, src: string) => {
      const v = evaluate(src, scope, opts);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope, opts));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope, opts);
    return out;
  }
  return value;
}
