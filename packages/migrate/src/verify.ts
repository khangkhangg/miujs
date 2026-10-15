// Contract verification: replay captured cases against the old and new apps (or the recorded
// responses) and diff status, selected headers and JSON bodies structurally.

import { parseCases, type CaptureEntry } from "./capture.ts";
import { migrateError } from "./errors.ts";

export interface Diff {
  /** JSONPath-like location: `$.items[0].name`, or `status`, or `header:<name>`. */
  path: string;
  kind: "changed" | "type" | "added" | "removed";
  old?: unknown;
  new?: unknown;
}

type Seg = string | number;
type Pat = { t: "key"; k: string } | { t: "idx"; i: number } | { t: "any" } | { t: "deep"; inner: Pat };

const IDENT = /^[A-Za-z_$][\w$]*$/;

function formatPath(segs: Seg[]): string {
  let s = "$";
  for (const x of segs) s += typeof x === "number" ? `[${x}]` : IDENT.test(x) ? `.${x}` : `[${JSON.stringify(x)}]`;
  return s;
}

const badIgnore = (p: string) => migrateError("CONFIG", 500, `Ignore path "${p}" is not valid`, 'Use JSONPath like "$.createdAt", "$.items[*].updatedAt", "$.meta.*" or "$..updatedAt".');

function parsePath(p: string): Pat[] {
  if (!p.startsWith("$")) throw badIgnore(p);
  const out: Pat[] = [];
  let i = 1;
  while (i < p.length) {
    let deep = false;
    if (p.startsWith("..", i)) {
      deep = true;
      i += 2;
    } else if (p[i] === ".") i++;
    let seg: Pat;
    if (p[i] === "[") {
      const end = p.indexOf("]", i);
      if (end === -1) throw badIgnore(p);
      let inner = p.slice(i + 1, end);
      if (inner.startsWith('"')) {
        // Quoted keys may contain "]": find the closing quote first.
        const close = p.indexOf('"]', i + 2);
        if (close === -1) throw badIgnore(p);
        inner = p.slice(i + 1, close + 1);
        i = close + 2;
        try {
          seg = { t: "key", k: JSON.parse(inner) };
        } catch {
          throw badIgnore(p);
        }
      } else {
        i = end + 1;
        if (inner === "*") seg = { t: "any" };
        else if (/^\d+$/.test(inner)) seg = { t: "idx", i: Number(inner) };
        else throw badIgnore(p);
      }
    } else {
      const m = /^(\*|[^.[\]]+)/.exec(p.slice(i));
      if (!m) throw badIgnore(p);
      i += m[0].length;
      seg = m[0] === "*" ? { t: "any" } : { t: "key", k: m[0] };
    }
    out.push(deep ? { t: "deep", inner: seg } : seg);
  }
  return out;
}

function segMatches(p: Pat, s: Seg): boolean {
  if (p.t === "any") return true;
  if (p.t === "key") return typeof s === "string" ? p.k === s : p.k === String(s);
  if (p.t === "idx") return s === p.i;
  return false;
}

/** True when `segs` lies at or under the pattern (ignoring a node ignores its children). */
function matchPat(pat: Pat[], segs: Seg[], pi = 0, si = 0): boolean {
  if (pi === pat.length) return true;
  const p = pat[pi];
  if (p.t === "deep") {
    for (let j = si; j < segs.length; j++) if (segMatches(p.inner, segs[j]) && matchPat(pat, segs, pi + 1, j + 1)) return true;
    return false;
  }
  return si < segs.length && segMatches(p, segs[si]) && matchPat(pat, segs, pi + 1, si + 1);
}

function toSegs(path: string): Seg[] {
  return parsePath(path).map((p) => (p.t === "key" ? p.k : p.t === "idx" ? p.i : "*"));
}

/** Whether a concrete path (as printed in diffs) is covered by one of the ignore patterns. */
export function matchesIgnore(path: string, ignore: string[]): boolean {
  const segs = toSegs(path);
  return ignore.some((p) => matchPat(parsePath(p), segs));
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

const REDACTION = /^\[(REDACTED|TOKEN)\]$|\[EMAIL\]/;

export interface DiffOptions {
  /** Treat redaction markers in the old value ("[REDACTED]", "[TOKEN]", "[EMAIL]") as matching anything. */
  redactedMatchesAny?: boolean;
}

/** Structural diff of two JSON values. Objects by key (old order, then new keys), arrays by index. */
export function diffJson(oldValue: unknown, newValue: unknown, ignore: string[] = [], opts: DiffOptions = {}): Diff[] {
  const pats = ignore.map(parsePath);
  const out: Diff[] = [];
  const ignored = (segs: Seg[]) => pats.some((p) => matchPat(p, segs));
  const walk = (a: unknown, b: unknown, segs: Seg[]) => {
    if (ignored(segs)) return;
    if (opts.redactedMatchesAny && typeof a === "string" && REDACTION.test(a)) return;
    const ka = kindOf(a);
    const kb = kindOf(b);
    if (ka !== kb) {
      out.push({ path: formatPath(segs), kind: "type", old: a, new: b });
      return;
    }
    if (ka === "array") {
      const x = a as unknown[];
      const y = b as unknown[];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const s = [...segs, i];
        if (i >= y.length) {
          if (!ignored(s)) out.push({ path: formatPath(s), kind: "removed", old: x[i] });
        } else if (i >= x.length) {
          if (!ignored(s)) out.push({ path: formatPath(s), kind: "added", new: y[i] });
        } else walk(x[i], y[i], s);
      }
      return;
    }
    if (ka === "object") {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      for (const k of Object.keys(x)) {
        const s = [...segs, k];
        if (Object.hasOwn(y, k)) walk(x[k], y[k], s);
        else if (!ignored(s)) out.push({ path: formatPath(s), kind: "removed", old: x[k] });
      }
      for (const k of Object.keys(y)) {
        const s = [...segs, k];
        if (!Object.hasOwn(x, k) && !ignored(s)) out.push({ path: formatPath(s), kind: "added", new: y[k] });
      }
      return;
    }
    if (!Object.is(a, b) && !(a === 0 && b === 0)) out.push({ path: formatPath(segs), kind: "changed", old: a, new: b });
  };
  walk(oldValue, newValue, []);
  return out;
}

// --- replay ----------------------------------------------------------------------------------

/** An app (anything with `fetch(req)`), a fetch function, or a base URL. */
export type Target = string | { fetch(req: Request, ...rest: any[]): Response | Promise<Response> } | ((req: Request) => Response | Promise<Response>);

export interface VerifyOptions {
  /** Cases from captureMiddleware: an array or JSONL text. */
  cases: CaptureEntry[] | string;
  /** The old app. Omit to compare with the recorded responses in the cases. */
  old?: Target;
  new: Target;
  /** JSONPath patterns to skip: "$.createdAt", "$.items[*].updatedAt", "$..id", "$.meta.*". */
  ignore?: string[];
  /** Response headers compared. Default ["content-type"] (media type only, parameters ignored). */
  headers?: string[];
  /** Headers added to every replayed request, e.g. a test user's session cookie. */
  requestHeaders?: Record<string, string>;
  /** Choose which cases to run. */
  filter?: (c: CaptureEntry) => boolean;
}

export interface CaseResult {
  name: string;
  method: string;
  path: string;
  ok: boolean;
  status: { old: number | null; new: number | null };
  diffs: Diff[];
  error?: string;
}

export interface VerifyReport {
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
}

interface Observed {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  json: boolean;
}

function toFetcher(t: Target): (req: Request) => Promise<Response> {
  if (typeof t === "string") {
    const base = t.replace(/\/+$/, "");
    return async (req) => {
      const u = new URL(req.url);
      return fetch(new Request(base + u.pathname + u.search, req), { redirect: "manual" });
    };
  }
  if (typeof t === "function") return async (req) => t(req);
  return async (req) => t.fetch(req);
}

function buildRequest(c: CaptureEntry, extra: Record<string, string>): Request {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(c.query ?? {})) for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x));
  const q = qs.toString();
  const headers = new Headers();
  for (const [k, v] of Object.entries(c.headers ?? {})) if (!REDACTION.test(v)) headers.set(k, v);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  let body: string | undefined;
  if (c.body !== null && c.body !== undefined && c.method !== "GET" && c.method !== "HEAD") {
    if (typeof c.body === "string") body = c.body;
    else {
      const type = headers.get("content-type") ?? "";
      if (type.includes("x-www-form-urlencoded")) {
        const f = new URLSearchParams();
        for (const [k, v] of Object.entries(c.body as Record<string, unknown>)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, String(x));
        body = f.toString();
      } else {
        body = JSON.stringify(c.body);
        if (!type) headers.set("content-type", "application/json");
      }
    }
  }
  return new Request(`http://localhost${c.path}${q ? `?${q}` : ""}`, { method: c.method, headers, body });
}

async function observe(res: Response, names: string[]): Promise<Observed> {
  const headers: Record<string, string> = {};
  for (const n of names) {
    const v = res.headers.get(n);
    if (v !== null) headers[n] = v;
  }
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return { status: res.status, headers, body: text ? JSON.parse(text) : null, json: true };
    } catch {}
  }
  return { status: res.status, headers, body: text, json: false };
}

function normHeader(name: string, v: string | undefined): string | undefined {
  if (v === undefined) return v;
  return name === "content-type" ? v.split(";")[0].trim().toLowerCase() : v;
}

/** Replays cases against both apps and diffs the responses. */
export async function verifyContracts(opts: VerifyOptions): Promise<VerifyReport> {
  let cases = typeof opts.cases === "string" ? parseCases(opts.cases) : opts.cases;
  if (opts.filter) cases = cases.filter(opts.filter);
  const names = (opts.headers ?? ["content-type"]).map((h) => h.toLowerCase());
  const ignore = opts.ignore ?? [];
  ignore.forEach(parsePath); // fail fast on a bad pattern
  const oldF = opts.old === undefined ? null : toFetcher(opts.old);
  const newF = toFetcher(opts.new);
  const extra = opts.requestHeaders ?? {};
  const results: CaseResult[] = [];

  for (const c of cases) {
    const name = c.name ?? `${c.method} ${c.path}`;
    const result: CaseResult = { name, method: c.method, path: c.path, ok: false, status: { old: null, new: null }, diffs: [] };
    results.push(result);
    let o: Observed;
    let n: Observed;
    const recorded = oldF === null;
    try {
      o = recorded
        ? { status: c.status, headers: c.responseHeaders ?? {}, body: c.response, json: typeof c.response === "object" }
        : await observe(await oldF(buildRequest(c, extra)), names);
    } catch (err) {
      result.error = `old app request failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    try {
      n = await observe(await newF(buildRequest(c, extra)), names);
    } catch (err) {
      result.error = `new app request failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    result.status = { old: o.status, new: n.status };
    if (o.status !== n.status) result.diffs.push({ path: "status", kind: "changed", old: o.status, new: n.status });
    for (const h of names) {
      if (recorded && o.headers[h] === undefined) continue;
      const a = normHeader(h, o.headers[h]);
      const b = normHeader(h, n.headers[h]);
      if (a !== b) result.diffs.push({ path: `header:${h}`, kind: "changed", old: a ?? null, new: b ?? null });
    }
    if (o.json && n.json) {
      result.diffs.push(...diffJson(o.body, n.body, ignore, { redactedMatchesAny: recorded }));
    } else if (!(recorded && o.body === null) && o.body !== n.body) {
      const cut = (v: unknown) => (typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v);
      result.diffs.push({ path: "$", kind: o.json === n.json ? "changed" : "type", old: cut(o.body), new: cut(n.body) });
    }
    result.ok = result.diffs.length === 0;
  }
  const passed = results.filter((r) => r.ok).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

/** Plain-text report for the CLI. */
export function formatReport(report: VerifyReport): string {
  const j = (v: unknown) => JSON.stringify(v);
  const lines: string[] = [];
  for (const r of report.results) {
    lines.push(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    if (r.error) lines.push(`  error: ${r.error}`);
    for (const d of r.diffs) {
      if (d.kind === "added") lines.push(`  ${d.path}: added ${j(d.new)}`);
      else if (d.kind === "removed") lines.push(`  ${d.path}: removed ${j(d.old)}`);
      else lines.push(`  ${d.path}: ${d.kind} ${j(d.old)} -> ${j(d.new)}`);
    }
  }
  lines.push(`${report.passed} passed, ${report.failed} failed (of ${report.total})`);
  return lines.join("\n");
}
