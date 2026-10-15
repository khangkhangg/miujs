// Builds docs/errors.md from the MIU_E_* / MIU_W_* codes in packages/*/src.
//
//   bun scripts/error-catalog.ts           # regenerate docs/errors.md
//   bun scripts/error-catalog.ts --check   # exit 1 if a code in source is missing from docs/errors.md (CI)
//
// Messages and fixes are read statically, without running anything. It understands:
//   new MiuError({ code, status, message, fix }) and errors.custom({...}), including
//     `cond ? "MIU_E_A" : "MIU_E_B"` codes;
//   factories whose code is a parameter or `MIU_E_PREFIX_${code}` (errors.config, oauthError,
//     filesErrors.badRequest, ...): every call that passes a literal code becomes an entry;
//   helper calls whose first argument is a literal code: (code, message, fix) or (code, status, message, fix);
//   CLI lines written as `CODE message. Fix: fix`.
// Anything else that mentions a code still gets a section, with a link to the source.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENTED_PACKAGES, ROOT, slash } from "./lib/repo.ts";

export interface SourceFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  text: string;
}

export interface Occurrence {
  /** "error": defined here (thrown, built or printed). "mention": the code only appears, e.g. in a comment. */
  kind: "error" | "mention";
  code: string;
  pkg: string;
  file: string;
  status: number | null;
  message: string | null;
  fix: string | null;
}

export interface CatalogEntry {
  code: string;
  pkg: string;
  packages: string[];
  files: string[];
  statuses: number[];
  messages: string[];
  fixes: string[];
}

const CODE_RE = /(?<![A-Za-z0-9_])MIU_[EW]_[A-Z0-9]+(?:_[A-Z0-9]+)*(?![A-Za-z0-9_$*{])/g;
const IS_CODE = /^MIU_[EW]_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/** GitHub's heading id: lowercase, punctuation other than `-` and `_` dropped, spaces to `-`. */
export function githubAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

// ---------------------------------------------------------------- a tiny TypeScript-aware reader

/** Index just past the string/template literal starting at `i`. */
function skipString(src: string, i: number): number {
  const q = src[i++];
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") i += 2;
    else if (c === q) return i + 1;
    else if (q === "`" && c === "$" && src[i + 1] === "{") i = skipBalanced(src, i + 1);
    else if (q !== "`" && c === "\n") return i;
    else i++;
  }
  return i;
}

function skipComment(src: string, i: number): number {
  if (src[i + 1] === "/") {
    const end = src.indexOf("\n", i);
    return end < 0 ? src.length : end;
  }
  const end = src.indexOf("*/", i + 2);
  return end < 0 ? src.length : end + 2;
}

const isQuote = (c: string) => c === '"' || c === "'" || c === "`";
const isComment = (src: string, i: number) => src[i] === "/" && (src[i + 1] === "/" || src[i + 1] === "*");

/** `src[open]` is ( [ or {. Returns the index just past its matching closer. */
function skipBalanced(src: string, open: number): number {
  const closer: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack = [closer[src[open]]];
  let i = open + 1;
  while (i < src.length && stack.length) {
    const c = src[i];
    if (isQuote(c)) i = skipString(src, i);
    else if (isComment(src, i)) i = skipComment(src, i);
    else {
      if (closer[c]) stack.push(closer[c]);
      else if (c === stack[stack.length - 1]) stack.pop();
      i++;
    }
  }
  return i;
}

/** Splits on `sep` at nesting depth 0, outside strings and comments. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (isQuote(c)) i = skipString(text, i);
    else if (isComment(text, i)) i = skipComment(text, i);
    else if (c === "(" || c === "[" || c === "{") i = skipBalanced(text, i);
    else if (c === sep && !(sep === "+" && (text[i + 1] === "+" || text[i + 1] === "="))) {
      parts.push(text.slice(start, i));
      i++;
      start = i;
    } else i++;
  }
  parts.push(text.slice(start));
  const trimmed = parts.map((p) => p.trim());
  if (trimmed.length > 1 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}

/** Arguments of the call whose `(` is at `open`. */
function readArgs(src: string, open: number): string[] {
  const end = skipBalanced(src, open);
  const inner = src.slice(open + 1, end - 1);
  return inner.trim() === "" ? [] : splitTop(inner, ",");
}

/** Top-level `key: value` pairs of an object literal (shorthand `key` maps to `key`). */
function readObject(text: string): Map<string, string> | null {
  const t = text.trim();
  if (!t.startsWith("{") || skipBalanced(t, 0) !== t.length) return null;
  const props = new Map<string, string>();
  for (const part of splitTop(t.slice(1, -1), ",")) {
    const m = /^([\w$]+)\s*(?::\s*([\s\S]*))?$/.exec(part);
    if (m) props.set(m[1], (m[2] ?? m[1]).trim());
  }
  return props;
}

/** `cond ? a : b` at the top level, or null. */
function splitTernary(expr: string): [string, string, string] | null {
  let i = 0;
  let q = -1;
  let depth = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (isQuote(c)) {
      i = skipString(expr, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      i = skipBalanced(expr, i);
      continue;
    }
    if (c === "?" && expr[i + 1] !== "." && expr[i + 1] !== "?" && expr[i - 1] !== "?") {
      if (q < 0) q = i;
      else depth++;
    } else if (c === ":" && q >= 0) {
      if (depth === 0) return [expr.slice(0, q).trim(), expr.slice(q + 1, i).trim(), expr.slice(i + 1).trim()];
      depth--;
    }
    i++;
  }
  return null;
}

function unescape(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e: string) => {
    if (e === "n" || e === "r" || e === "t") return " ";
    if (e[0] === "u" && e.length > 1) return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ""), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e;
  });
}

const NOT_NAMES = new Set(["as", "typeof", "new", "await", "null", "undefined", "true", "false", "void"]);

/** `{name}` for the most telling variable in an interpolated expression. */
function placeholder(expr: string): string {
  const re = /[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/g;
  for (let m = re.exec(expr); m; m = re.exec(expr)) {
    const after = expr.slice(m.index + m[0].length).trimStart();
    if (after.startsWith("(") || NOT_NAMES.has(m[0])) continue;
    if (expr[m.index - 1] === "." || /^[A-Z]/.test(m[0]) && /^(JSON|String|Number|Object|Array|Math|Error|Boolean)/.test(m[0])) continue;
    return `{${m[0].replace(/\?\./g, ".")}}`;
  }
  return "{…}";
}

/** The text of a string, template or `"a" + b` expression, with `{name}` for the dynamic parts. */
export function staticText(expr: string | undefined): string | null {
  const raw = rawText(expr);
  return raw === null ? null : clean(raw);
}

function rawText(expr: string | undefined): string | null {
  if (expr === undefined) return null;
  let e = expr.trim();
  while (e.startsWith("(") && skipBalanced(e, 0) === e.length) e = e.slice(1, -1).trim();
  if (e === "") return null;
  if ((e[0] === '"' || e[0] === "'") && skipString(e, 0) === e.length) return unescape(e.slice(1, -1));
  if (e[0] === "`" && skipString(e, 0) === e.length) {
    let out = "";
    let i = 1;
    while (i < e.length - 1) {
      if (e[i] === "\\") {
        out += unescape(e.slice(i, i + 2));
        i += 2;
      } else if (e[i] === "$" && e[i + 1] === "{") {
        const end = skipBalanced(e, i + 1);
        out += placeholder(e.slice(i + 2, end - 1));
        i = end;
      } else out += e[i++];
    }
    return out;
  }
  const tern = splitTernary(e);
  if (tern) {
    const [a, b] = [rawText(tern[1]), rawText(tern[2])];
    if (a !== null && b !== null) return `${a} (otherwise: ${b})`;
  }
  const parts = splitTop(e, "+");
  if (parts.length > 1 && parts.some((p) => isQuote(p[0] ?? ""))) {
    return parts.map((p) => (isQuote(p[0] ?? "") ? rawText(p) ?? "" : placeholder(p))).join("");
  }
  return null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const numberLiteral = (e: string | undefined) => (e !== undefined && /^\d{3}$/.test(e.trim()) ? Number(e.trim()) : null);

// ---------------------------------------------------------------- factories

interface Param {
  name: string;
  type?: string;
  def?: string;
}

interface Factory {
  /** `obj.name(...)` for object members, bare `name(...)` otherwise. */
  obj?: string;
  name: string;
  params: Param[];
  /** Fixed code, or prefix + the literal passed for parameter `index`. */
  code: { fixed: string } | { prefix: string; index: number };
  props: { status?: string; message?: string; fix?: string };
}

/** errors.config(code, message, fix, details) from miujs: a startup error, always 500. */
const BUILTIN: Factory[] = [
  {
    obj: "errors",
    name: "config",
    params: [{ name: "code" }, { name: "message" }, { name: "fix" }, { name: "details" }],
    code: { prefix: "", index: 0 },
    props: { status: "500", message: "message", fix: "fix" },
  },
];

function parseParams(list: string): Param[] {
  if (list.trim() === "") return [];
  return splitTop(list, ",").map((p) => {
    const m = /^(?:\.\.\.)?([\w$]+)\??\s*(?::\s*([\s\S]+?))?\s*(?:=\s*([\s\S]+))?$/.exec(p.trim());
    return m ? { name: m[1], type: m[2]?.trim(), def: m[3]?.trim() } : { name: p.trim() };
  });
}

/** The function a position sits in: `function f(..)`, `f: (..) =>` in an object, or `const f = (..) =>`. */
function enclosingFunction(src: string, pos: number): { name: string; obj?: string; params: Param[] } | null {
  const before = src.slice(0, pos);
  const patterns: [RegExp, boolean][] = [
    [/function\s+([\w$]+)\s*\(([^()]*)\)/g, false],
    [/(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^()]*)\)\s*(?::\s*[^=;]+?)?=>/g, false],
    [/(?<![\w$.])([\w$]+)\s*:\s*(?:async\s*)?\(([^()]*)\)\s*(?::\s*[^=;]+?)?=>/g, true],
  ];
  let best: { index: number; name: string; list: string; member: boolean } | null = null;
  for (const [re, member] of patterns) {
    for (const m of before.matchAll(re)) {
      if (!best || m.index! > best.index) best = { index: m.index!, name: m[1], list: m[2], member };
    }
  }
  if (!best) return null;
  let obj: string | undefined;
  if (best.member) {
    const objs = [...src.slice(0, best.index).matchAll(/(?:const|let)\s+([\w$]+)\s*(?::[^=]+)?=\s*\{/g)];
    obj = objs.length ? objs[objs.length - 1][1] : undefined;
    if (!obj) return null;
  }
  return { name: best.name, obj, params: parseParams(best.list) };
}

// ---------------------------------------------------------------- scanning

const CONSTRUCT_RE = /\bnew\s+MiuError\s*\(|(?<![\w$])errors\s*\.\s*custom\s*\(/g;
const CODE_PROP_RE = /(?<![\w$])code\s*:\s*(?=["'`]MIU_[EW]_)/g;

/** The innermost object literal around `pos`, if any, as props. */
function enclosingObject(src: string, pos: number): Map<string, string> | null {
  for (let i = pos; i >= 0 && i > pos - 4000; i--) {
    if (src[i] !== "{") continue;
    const end = skipBalanced(src, i);
    if (end <= pos) continue;
    return readObject(src.slice(i, end));
  }
  return null;
}

/** Every code occurrence in one package's source files. */
export function scanPackage(pkg: string, files: SourceFile[]): Occurrence[] {
  const out: Occurrence[] = [];
  const factories: Factory[] = [...BUILTIN];
  const add = (o: Omit<Occurrence, "pkg">) => out.push({ pkg, ...o });
  const known = new Set<string>();
  /** Registers a factory once; true if new. */
  const addFactory = (f: Factory) => {
    const key = `${f.obj ?? ""}.${f.name}`;
    if (known.has(key)) return false;
    known.add(key);
    factories.push(f);
    return true;
  };
  BUILTIN.forEach((b) => known.add(`${b.obj ?? ""}.${b.name}`));

  /** A function forwarding its own params into a code-producing call is itself a factory. */
  const maybeWrapper = (f: SourceFile, pos: number, code: Factory["code"], props: Factory["props"]) => {
    const fn = enclosingFunction(f.text, pos);
    if (!fn) return;
    const names = new Set(fn.params.map((p) => p.name));
    const usesParam = Object.values(props).some((v) => v !== undefined && names.has(v.trim()));
    if (usesParam) addFactory({ obj: fn.obj, name: fn.name, params: fn.params, code, props });
  };

  // 1. Object literals with a literal code: MiuError inits, WebSocket error frames, etc.
  for (const f of files) {
    for (const m of f.text.matchAll(CODE_PROP_RE)) {
      const props = enclosingObject(f.text, m.index!);
      const code = props && staticText(props.get("code"));
      if (!props || !code || !IS_CODE.test(code)) continue;
      const pick = { status: props.get("status"), message: props.get("message"), fix: props.get("fix") };
      add({ kind: "error", code, file: f.path, status: numberLiteral(pick.status), message: staticText(pick.message), fix: staticText(pick.fix) });
      maybeWrapper(f, m.index!, { fixed: code }, pick);
    }
  }

  // 2. MiuError constructions whose code is computed: ternaries and parameterized factories.
  for (const f of files) {
    for (const m of f.text.matchAll(CONSTRUCT_RE)) {
      const args = readArgs(f.text, m.index! + m[0].length - 1);
      const props = args[0] ? readObject(args[0]) : null;
      if (!props || !props.has("code")) continue;
      const codeExpr = props.get("code")!;
      const pick = { status: props.get("status"), message: props.get("message"), fix: props.get("fix") };
      const ternary = splitTernary(codeExpr);
      const template = /^`(MIU_[EW]_[A-Z0-9_]*?)\$\{\s*([\w$]+)\s*\}`$/.exec(codeExpr);
      if (ternary) {
        const [cond, a, b] = ternary;
        for (const [branch, codeText] of [[1, a], [2, b]] as const) {
          const code = staticText(codeText);
          if (!code || !IS_CODE.test(code)) continue;
          const choose = (v?: string) => {
            const t = v === undefined ? null : splitTernary(v);
            return t && t[0] === cond ? t[branch] : v;
          };
          add({ kind: "error", code, file: f.path, status: numberLiteral(choose(pick.status)), message: staticText(choose(pick.message)), fix: staticText(choose(pick.fix)) });
        }
        continue;
      }
      if (!template && !/^[\w$]+$/.test(codeExpr)) continue;
      const fn = enclosingFunction(f.text, m.index!);
      if (!fn) continue;
      const prefix = template ? template[1] : "";
      const index = fn.params.findIndex((p) => p.name === (template ? template[2] : codeExpr));
      if (index < 0) continue;
      addFactory({ obj: fn.obj, name: fn.name, params: fn.params, code: { prefix, index }, props: pick });
      // `code: "REDIS" | "SQLITE"` lists the codes itself.
      const union = fn.params[index].type;
      if (union && /^"[A-Z0-9_]+"(\s*\|\s*"[A-Z0-9_]+")*$/.test(union)) {
        for (const lit of union.match(/[A-Z0-9_]+/g)!) {
          add({ kind: "error", code: prefix + lit, file: f.path, status: numberLiteral(pick.status), message: staticText(pick.message), fix: staticText(pick.fix) });
        }
      }
    }
  }

  // 3. Calls to factories (and to wrappers found along the way) with a literal code.
  for (let i = 0; i < factories.length; i++) {
    const fac = factories[i];
    const callee = fac.obj ? String.raw`(?<![\w$])${fac.obj}\s*\.\s*${fac.name}` : String.raw`(?<![\w$.])(?<!function\s+)${fac.name}`;
    const re = new RegExp(String.raw`${callee}\s*\(`, "g");
    for (const f of files) {
      for (const m of f.text.matchAll(re)) {
        const args = readArgs(f.text, m.index! + m[0].length - 1);
        const env = new Map<string, string | undefined>();
        fac.params.forEach((p, j) => env.set(p.name, args[j] ?? p.def));
        let code: string;
        if ("fixed" in fac.code) code = fac.code.fixed;
        else {
          const lit = staticText(args[fac.code.index]);
          if (!lit || !/^[A-Z0-9_]+$/.test(lit)) continue;
          code = fac.code.prefix + lit;
        }
        if (!IS_CODE.test(code)) continue;
        const resolve = (expr?: string) => (expr !== undefined && env.has(expr.trim()) ? env.get(expr.trim()) : expr);
        const props = { status: resolve(fac.props.status), message: resolve(fac.props.message), fix: resolve(fac.props.fix) };
        add({ kind: "error", code, file: f.path, status: numberLiteral(props.status), message: staticText(props.message), fix: staticText(props.fix) });
        maybeWrapper(f, m.index!, { fixed: code }, props);
      }
    }
  }

  // 4. Other calls whose first argument is a literal code: (code, message, fix) or (code, status, message, fix).
  const factoryCallee = new Set(factories.map((f) => (f.obj ? `${f.obj}.${f.name}` : f.name)));
  for (const f of files) {
    for (const m of f.text.matchAll(/([\w$.]+)\s*\(\s*(?=["'`]MIU_[EW]_)/g)) {
      if (factoryCallee.has(m[1]) || /(^|\.)(custom|includes|startsWith|has|get|push|toBe|toEqual)$/.test(m[1])) continue;
      const args = readArgs(f.text, m.index! + m[0].indexOf("("));
      const code = staticText(args[0]);
      if (!code || !IS_CODE.test(code)) continue;
      const status = numberLiteral(args[1]);
      const [msg, fix] = status === null ? [args[1], args[2]] : [args[2], args[3]];
      add({ kind: "error", code, file: f.path, status, message: staticText(msg), fix: staticText(fix) });
    }
  }

  // 5. Everything else: CLI-style `CODE message. Fix: fix` lines, then plain mentions.
  for (const f of files) {
    const defined = new Set(out.filter((o) => o.file === f.path && o.kind === "error").map((o) => o.code));
    const seen = new Set<string>();
    for (const m of f.text.matchAll(CODE_RE)) {
      const code = m[0];
      if (defined.has(code) || seen.has(code)) continue;
      const lineEnd = f.text.indexOf("\n", m.index!);
      const rest = f.text.slice(m.index! + code.length, lineEnd < 0 ? undefined : lineEnd);
      const cli = /^\s+([\s\S]+?)\s*Fix:\s*([\s\S]+?)`\s*\)/.exec(rest);
      if (cli) {
        add({ kind: "error", code, file: f.path, status: null, message: staticText("`" + cli[1] + "`"), fix: staticText("`" + cli[2] + "`") });
        defined.add(code);
      } else {
        add({ kind: "mention", code, file: f.path, status: null, message: null, fix: null });
        seen.add(code);
      }
    }
  }
  return out;
}

function listSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out.sort();
}

/** Scans every package in the repo. */
export function scanRepo(): Occurrence[] {
  const out: Occurrence[] = [];
  for (const pkg of readdirSync(join(ROOT, "packages")).sort()) {
    const files = listSources(join(ROOT, "packages", pkg, "src")).map((p) => ({ path: slash(p.slice(ROOT.length + 1)), text: readFileSync(p, "utf8") }));
    out.push(...scanPackage(pkg, files));
  }
  return out;
}

const pkgRank = (pkg: string) => {
  const i = (DOCUMENTED_PACKAGES as readonly string[]).indexOf(pkg);
  return i < 0 ? DOCUMENTED_PACKAGES.length : i;
};
const byPkg = (a: string, b: string) => pkgRank(a) - pkgRank(b) || a.localeCompare(b);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Groups occurrences by code (scans the repo when none are given), ordered by package then code. */
export function collectCodes(occurrences: Occurrence[] = scanRepo()): Map<string, CatalogEntry> {
  const groups = new Map<string, Occurrence[]>();
  for (const o of occurrences) groups.set(o.code, [...(groups.get(o.code) ?? []), o]);
  const entries: CatalogEntry[] = [];
  for (const [code, all] of groups) {
    const defs = all.filter((o) => o.kind === "error");
    const src = defs.length ? defs : all;
    const packages = uniq(src.map((o) => o.pkg)).sort(byPkg);
    entries.push({
      code,
      pkg: packages[0],
      packages,
      files: uniq(src.map((o) => o.file)).sort(),
      statuses: uniq(defs.map((o) => o.status).filter((s): s is number => s !== null)).sort(),
      messages: uniq(defs.map((o) => o.message).filter((s): s is string => !!s)),
      fixes: uniq(defs.map((o) => o.fix).filter((s): s is string => !!s)),
    });
  }
  entries.sort((a, b) => byPkg(a.pkg, b.pkg) || a.code.localeCompare(b.code));
  return new Map(entries.map((e) => [e.code, e]));
}

// ---------------------------------------------------------------- rendering

/** Plain-language notes for codes whose message alone doesn't say enough. */
const NOTES: Record<string, string> = {
  MIU_E_NOT_FOUND: "A handler threw `errors.notFound()`: the resource it looked up does not exist.",
  MIU_E_BAD_REQUEST: "The request is malformed in a way the route can't accept (for example unreadable JSON).",
  MIU_E_VALIDATION: "Params, query, body or headers don't match the route's `t` schema. `details.issues` lists each problem with its path.",
  MIU_E_RESPONSE_INVALID: "In dev, the handler returned data that doesn't match the route's `response` schema.",
  MIU_E_UNAUTHORIZED: "The route needs a signed-in user (`auth: \"required\"` or a role) and the request has none.",
  MIU_E_FORBIDDEN: "The user is signed in but not allowed to do this (missing role or permission).",
  MIU_E_CONFLICT: "The request conflicts with existing data, for example a duplicate unique value.",
  MIU_E_RATE_LIMITED: "Too many requests in the current window. The response carries `Retry-After`.",
  MIU_E_INTERNAL: "An unexpected error. In production the message is hidden; check the server log for the cause.",
};

const npmName = (pkg: string) => (pkg === "miujs" ? "miujs" : `@miujs/${pkg}`);

/** Escapes `<` and `>` outside code spans so messages can't turn into HTML. */
function md(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("");
}

function block(label: string, items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return `**${label}:** ${md(items[0])}\n\n`;
  return `**${label}:**\n\n${items.slice(0, 6).map((x) => `- ${md(x)}`).join("\n")}\n\n`;
}

export function renderCatalog(entries: Map<string, CatalogEntry>): string {
  const list = [...entries.values()];
  let out = `# MiuJS error codes

Every error MiuJS returns or throws has a stable code. A code is never reworded once released;
messages and fixes may improve.

\`\`\`json
{ "error": { "code": "MIU_E_NOT_FOUND", "message": "user \\"7\\" not found",
  "docs": "https://github.com/khangkhangg/miujs/blob/miujs-monorepo/docs/errors.md#miu_e_not_found" } }
\`\`\`

The \`docs\` link in every error body points at the code's section below (the code in lowercase).
\`MIU_E_*\` codes are errors; \`MIU_W_*\` codes are warnings printed by \`miu check\`.
Placeholders like \`{id}\` stand for values filled in at runtime.

This file is generated from the sources by \`bun scripts/error-catalog.ts\`. Don't edit it by hand:
change the message or fix where the error is thrown, then regenerate. CI fails when a code in
\`packages/*/src\` has no section here.

## Index

| Package | Codes |
| --- | --- |
`;
  const pkgs = uniq(list.map((e) => e.pkg));
  for (const pkg of pkgs) {
    const codes = list.filter((e) => e.pkg === pkg).map((e) => `[${e.code}](#${githubAnchor(e.code)})`);
    out += `| \`${npmName(pkg)}\` | ${codes.join(", ")} |\n`;
  }
  out += "\n";
  for (const e of list) {
    out += `## ${e.code}\n\n`;
    const status = e.code.startsWith("MIU_W_") ? "none (warning)" : e.statuses.length ? e.statuses.join(", ") : "not fixed (depends on the call)";
    out += `- **Package:** ${e.packages.map((p) => `\`${npmName(p)}\``).join(", ")}\n`;
    out += `- **HTTP status:** ${status}\n`;
    out += `- **Source:** ${e.files.map((f) => `[\`${f.replace(/^packages\//, "")}\`](../${f})`).join(", ")}\n\n`;
    const note = NOTES[e.code];
    if (note) out += `**What it means:** ${note}\n\n` + block("Message", e.messages);
    else if (e.messages.length) out += block("What it means", e.messages);
    else out += `**What it means:** See the source; this code has no static message.\n\n`;
    out += e.fixes.length ? block("How to fix", e.fixes) : `**How to fix:** Read the message and \`details\` in the error body, then the source linked above.\n\n`;
  }
  return out.trimEnd() + "\n";
}

/** Codes that have a `## MIU_...` section in a catalog. */
export function documentedCodes(markdown: string): string[] {
  return [...markdown.matchAll(/^## (MIU_[EW]_[A-Z0-9_]+)\s*$/gm)].map((m) => m[1]);
}

export const CATALOG_PATH = join(ROOT, "docs", "errors.md");

if (import.meta.main) {
  const entries = collectCodes();
  const next = renderCatalog(entries);
  if (process.argv.includes("--check")) {
    const current = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, "utf8") : "";
    const documented = new Set(documentedCodes(current));
    const missing = [...entries.keys()].filter((c) => !documented.has(c));
    const stale = [...documented].filter((c) => !entries.has(c));
    if (missing.length || stale.length) {
      if (missing.length) console.error(`Codes missing from docs/errors.md: ${missing.join(", ")}`);
      if (stale.length) console.error(`Sections for codes no longer in source: ${stale.join(", ")}`);
      console.error("Run: bun scripts/error-catalog.ts");
      process.exit(1);
    }
    if (current.replace(/\r\n/g, "\n") !== next) console.log("docs/errors.md has every code; some messages or fixes changed since it was generated (run bun scripts/error-catalog.ts to refresh).");
    console.log(`docs/errors.md documents all ${entries.size} codes.`);
  } else {
    writeFileSync(CATALOG_PATH, next);
    const empty = [...entries.values()].filter((e) => !e.messages.length && !NOTES[e.code]).map((e) => e.code);
    console.log(`Wrote docs/errors.md: ${entries.size} codes${empty.length ? `, ${empty.length} without a static message (${empty.join(", ")})` : ""}.`);
  }
}
