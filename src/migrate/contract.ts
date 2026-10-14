/**
 * Contract tests for migrations: record what the legacy app answers for a set
 * of requests, save it as JSON, then replay the same requests against the Miu
 * port and diff status, key headers and bodies.
 */

export interface ContractRequest {
  method?: string;
  /** Path plus query string, e.g. `/api/users?page=2`. */
  path: string;
  headers?: Record<string, string>;
  /** Strings are sent as-is; anything else as JSON. */
  body?: unknown;
}

export interface RecordedResponse {
  status: number;
  /** Lowercased header names, volatile ones removed. */
  headers: Record<string, string>;
  /** Parsed JSON, text, or null for an empty body. */
  body: unknown;
}

export interface Contract {
  version: 1;
  target: string;
  recordedAt: string;
  interactions: { request: ContractRequest; response: RecordedResponse }[];
}

export type BodyNormalizer = (body: unknown, request: ContractRequest) => unknown;

export interface NormalizeOptions {
  /** Field names removed from JSON bodies at any depth (e.g. `created_at`, `updated_at`). */
  ignoreFields?: string[];
  /** Applied to both recorded and actual bodies, after `ignoreFields`. */
  normalize?: BodyNormalizer;
}

export interface RecordOptions extends NormalizeOptions {
  target: string | URL;
  requests: ContractRequest[];
  /** Header names (besides the defaults) to leave out of the contract. */
  volatileHeaders?: string[];
  fetch?: (req: Request) => Promise<Response>;
}

/** Headers that differ between runs or servers and say nothing about behavior. */
export const VOLATILE_HEADERS = [
  "date", "set-cookie", "x-request-id", "x-correlation-id", "request-id", "age", "expires", "etag", "last-modified",
  "content-length", "connection", "keep-alive", "transfer-encoding", "server", "x-powered-by", "x-runtime", "vary",
];

/** Call the legacy app with each request and capture a JSON-serializable contract. */
export async function recordContract(opts: RecordOptions): Promise<Contract> {
  const target = new URL(opts.target);
  const doFetch = opts.fetch ?? ((r: Request) => fetch(r));
  const drop = new Set([...VOLATILE_HEADERS, ...(opts.volatileHeaders ?? []).map((h) => h.toLowerCase())]);
  const interactions: Contract["interactions"] = [];
  for (const request of opts.requests) {
    const base = target.pathname.replace(/\/+$/, "");
    const res = await doFetch(new Request(new URL(base + request.path, target.origin), { ...toInit(request), redirect: "manual" }));
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!drop.has(k)) headers[k] = v;
    });
    const body = normalizeBody(await readBody(res), request, opts);
    interactions.push({ request: { ...request, method: request.method ?? "GET" }, response: { status: res.status, headers, body } });
  }
  return { version: 1, target: target.href, recordedAt: new Date().toISOString(), interactions };
}

export interface VerifyOptions extends NormalizeOptions {
  /** Response headers to compare. Default `content-type` (media type only) and `location`. */
  headers?: string[];
  /** Headers never compared. */
  ignoreHeaders?: string[];
}

export interface ContractDiff {
  /** e.g. `GET /api/users/1` */
  request: string;
  /** `status`, `header.<name>`, `body` or `body.<json path>` like `body.items[0].name`. */
  path: string;
  expected: unknown;
  actual: unknown;
}

interface AppTarget {
  request(input: string, init?: RequestInit): Promise<Response> | Response;
}

/** Replay a contract against a Miu app (`app.request`) and list every difference. Empty means compatible. */
export async function verifyContract(app: AppTarget, contract: Contract, opts: VerifyOptions = {}): Promise<ContractDiff[]> {
  const ignore = new Set((opts.ignoreHeaders ?? []).map((h) => h.toLowerCase()));
  const compare = (opts.headers ?? ["content-type", "location"]).map((h) => h.toLowerCase()).filter((h) => !ignore.has(h));
  const diffs: ContractDiff[] = [];
  for (const { request, response: expected } of contract.interactions) {
    const label = `${request.method ?? "GET"} ${request.path}`;
    const res = await app.request(request.path, toInit(request));
    if (res.status !== expected.status) diffs.push({ request: label, path: "status", expected: expected.status, actual: res.status });
    for (const h of compare) {
      const want = headerValue(h, expected.headers[h]);
      const got = headerValue(h, res.headers.get(h) ?? undefined);
      if (want !== got) diffs.push({ request: label, path: `header.${h}`, expected: want, actual: got });
    }
    const actualBody = normalizeBody(await readBody(res), request, opts);
    const expectedBody = opts.normalize || opts.ignoreFields ? normalizeBody(expected.body, request, opts) : expected.body;
    deepDiff(expectedBody, actualBody, "body", (path, e, a) => diffs.push({ request: label, path, expected: e, actual: a }));
  }
  return diffs;
}

/** One line per diff, for test failure messages and CI logs. */
export function formatDiffs(diffs: ContractDiff[]): string {
  return diffs.map((d) => `${d.request} ${d.path}: expected ${show(d.expected)}, got ${show(d.actual)}`).join("\n");
}

// ---------- helpers ----------

function show(v: unknown): string {
  return v === undefined ? "(missing)" : JSON.stringify(v);
}

function toInit(r: ContractRequest): RequestInit {
  const headers = new Headers(r.headers);
  let body: string | undefined;
  if (r.body !== undefined) {
    if (typeof r.body === "string") body = r.body;
    else {
      body = JSON.stringify(r.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  return { method: r.method ?? "GET", headers, body };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through to text
    }
  }
  return text;
}

function headerValue(name: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  // PHP sends `text/html; charset=UTF-8`, Miu `text/html; charset=utf-8`; compare the media type.
  if (name === "content-type") return v.split(";")[0]!.trim().toLowerCase();
  return v;
}

function normalizeBody(body: unknown, request: ContractRequest, opts: NormalizeOptions): unknown {
  let out = body;
  if (opts.ignoreFields?.length) out = stripFields(out, new Set(opts.ignoreFields));
  return opts.normalize ? opts.normalize(out, request) : out;
}

function stripFields(v: unknown, fields: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => stripFields(x, fields));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!fields.has(k)) out[k] = stripFields(x, fields);
    return out;
  }
  return v;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deepDiff(e: unknown, a: unknown, path: string, report: (path: string, e: unknown, a: unknown) => void): void {
  if (Array.isArray(e) && Array.isArray(a)) {
    for (let i = 0; i < Math.max(e.length, a.length); i++) deepDiff(e[i], a[i], `${path}[${i}]`, report);
    return;
  }
  if (isObj(e) && isObj(a)) {
    for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
      deepDiff(e[k], a[k], path + key, report);
    }
    return;
  }
  if (!Object.is(e, a)) report(path, e, a);
}
