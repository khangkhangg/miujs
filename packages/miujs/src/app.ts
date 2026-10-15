import { RequestContext, addField, pathOf, type Context, type PlatformInfo, type RouteInfo, type Services, type TrustProxy } from "./context.ts";
import { MiuError, errors, isMiuError, type HeadersLike } from "./errors.ts";
import { createLogger, type LogLevel, type Logger } from "./logger.ts";
import { createMcpHandler, buildRouteTool, routeToolRequest, type McpOptions } from "./mcp.ts";
import { generateOpenApi, type DescribedRoute, type OpenApiInfo } from "./openapi.ts";
import type { CloudflareNeeds, McpTool, Plugin } from "./plugin.ts";
import { isAuthRequirement, isRoute, type AuthRequirement, type RouteDef } from "./route.ts";
import { Router, normalizePath, pathParams } from "./router.ts";
import { detectRuntime, processEnv, type Runtime } from "./runtime.ts";
import { isPlainStringObject, type Issue, type Schema } from "./schema.ts";
import { bunWebSocketHandler, resolveWebSocketLimits, type WebSocketLimits } from "./websocket.ts";

export type RouteSource = RouteDef | readonly RouteSource[] | Record<string, unknown>;

export interface MiuOptions {
  name?: string;
  version?: string;
  routes?: RouteSource[];
  plugins?: Plugin[];
  /** Serve every route as an MCP tool at `/mcp`. */
  mcp?: boolean | McpOptions;
  /** Serve OpenAPI at `/_miu/openapi.json`. Default: on in dev, off in production. */
  openapi?: boolean | { path?: string; info?: Partial<OpenApiInfo> };
  /** Dev mode checks response schemas and serves `/_miu/*`. Default: on unless MIU_ENV/NODE_ENV is production or running on Workers. */
  dev?: boolean;
  logLevel?: LogLevel | "silent";
  /** One log line per request. Default: on in dev. */
  logRequests?: boolean;
  /** Largest request body in bytes (JSON, form, text, binary). Default 10 MiB. Routes can override. */
  maxBodySize?: number;
  /** The reverse proxy in front of the app, so `ctx.ip` is the real client. See TrustProxy. */
  trustProxy?: TrustProxy;
  /**
   * WebSocket limits in bytes. `maxPayloadLength`: largest client message (default 1 MiB; a
   * bigger frame closes the socket with 1009). `backpressureLimit`: most bytes buffered for a
   * client that stops reading before its socket is closed (default 1 MiB). Bun enforces both;
   * on Deno and Workers `maxPayloadLength` is checked per message.
   */
  websocket?: WebSocketLimits;
}

export interface CallInput {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: HeadersLike;
}

export interface TestResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  /** Parsed JSON, or the text when the body is not JSON. */
  body: any;
  expectStatus(status: number): TestResponse;
}

export type CallFn = (route: RouteDef, input?: CallInput) => Promise<TestResponse>;

/** A route as a callable tool. See `app.tools()`. */
export interface AppTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, boolean>;
  /** The route name the tool calls. */
  route: string;
  call(args?: Record<string, unknown>, opts?: { headers?: HeadersLike; env?: unknown; origin?: string }): Promise<{ ok: boolean; status: number; body: unknown; text: string }>;
}

export interface RouteTest {
  name: string;
  fn: (call: CallFn) => unknown;
}

interface Compiled {
  name: string;
  method: string;
  path: string;
  def: RouteDef | null;
  info: RouteInfo;
  run: (ctx: RequestContext) => Response | Promise<Response>;
}

type WorkersHandler = (...args: any[]) => unknown;

const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Whether an app is in dev mode when `dev` isn't set: off on Workers or when MIU_ENV/NODE_ENV is "production". */
export function isDevDefault(runtime: Runtime = detectRuntime()): boolean {
  return defaultDev(runtime);
}

function defaultDev(runtime: Runtime): boolean {
  if (runtime === "workerd") return false;
  const env = processEnv();
  const mode = env.MIU_ENV ?? env.NODE_ENV;
  return mode !== "production";
}

function deriveName(method: string, path: string): string {
  const parts = normalizePath(path)
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith(":") ? `by_${s.slice(1)}` : s.startsWith("*") ? "rest" : s.replace(/[^A-Za-z0-9]+/g, "_")));
  return [method.toLowerCase(), ...parts].join("_");
}

// One issues array is reused while validation passes, so valid requests allocate none. It is
// taken out while in use (a parse that re-enters `check` gets its own) and given away on failure.
let spareIssues: Issue[] | null = [];

function check<T>(schema: Schema<T>, value: unknown, where: string, coerce: boolean): T {
  const issues = spareIssues ?? [];
  spareIssues = null;
  const out = schema.parse(value, where, issues, coerce);
  if (issues.length) throw errors.validation(where, issues);
  spareIssues = issues;
  return out;
}

const tooLarge = (limit: number) =>
  errors.custom({
    code: "MIU_E_BODY_TOO_LARGE",
    status: 413,
    message: `Request body is larger than ${limit} bytes`,
    fix: "Send a smaller body, or raise the limit with `maxBodySize` on the route or in miu({ maxBodySize }).",
  });

/**
 * The raw body bytes, never more than `limit`. A Content-Length over the limit is refused before
 * reading. Without one (chunked uploads) the body is read and then checked: memory stays bounded
 * by the server's own cap (Bun's maxRequestBodySize, set by listen(); the Node adapter's counter;
 * Workers' platform limit). Reading through a stream reader would cost ~25x more per request on Bun.
 */
/**
 * The body as text, never more than `limit` bytes. With a Content-Length (servers enforce it)
 * this is `req.text()`, the runtime's fast path; without one it goes through `readLimited`.
 */
async function readTextLimited(req: Request, limit: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (Number(declared) > limit) throw tooLarge(limit);
    return req.text();
  }
  // Same bound as readLimited (the whole body is read either way), without the extra copy.
  // A UTF-8 byte is at least one UTF-16 unit and at most three, so most bodies skip the count.
  const text = await req.text();
  if (text.length > limit || (text.length * 3 > limit && utf8Length(text) > limit)) throw tooLarge(limit);
  return text;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

async function readLimited(req: Request, limit: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw tooLarge(limit);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > limit) throw tooLarge(limit);
  return buf;
}

const utf8 = new TextDecoder();

async function readBody(req: Request, limit: number): Promise<{ value: unknown; form: boolean }> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("application/json") || type.includes("+json")) {
    const text = await readTextLimited(req, limit);
    if (text === "") return { value: undefined, form: false };
    try {
      return { value: JSON.parse(text), form: false };
    } catch {
      throw errors.custom({
        code: "MIU_E_BAD_JSON",
        status: 400,
        message: "Request body is not valid JSON",
        fix: "Send a JSON body with `content-type: application/json`.",
      });
    }
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const bytes = await readLimited(req, limit);
    const fd = await new Response(bytes as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? type } }).formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of fd as unknown as Iterable<[string, unknown]>) addField(out, k, v);
    return { value: out, form: true };
  }
  if (type.startsWith("text/")) return { value: await readTextLimited(req, limit), form: false };
  if (!req.body) return { value: undefined, form: false };
  const buf = await readLimited(req, limit);
  return { value: buf.length ? buf : undefined, form: false };
}

const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";
// Shared `Headers` instances: `new Response()` copies them, and on Bun copying a Headers is
// ~130 ns cheaper than building one from a plain object on every response.
const JSON_HEADERS = new Headers({ "content-type": JSON_TYPE });
const TEXT_HEADERS = new Headers({ "content-type": TEXT_TYPE });
const TEXT_INIT: ResponseInit = { headers: TEXT_HEADERS };
/** Longest text served from a route's cached Response (see responder); longer ones are built. */
const TEMPLATE_MAX = 1024;

/** Bun's own server object (`[object HTTPServer]`, `DebugHTTPServer`, `HTTPSServer`, ...), not a look-alike. */
function isBunServer(s: unknown): boolean {
  return /HTTPS?Server\]$/.test(Object.prototype.toString.call(s));
}

const MAX_SUGGEST_PATH = 200;

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * A MiuJS application. `export default app` works as-is on Bun, Deno (`deno serve`) and
 * Cloudflare Workers; call `app.listen()` to start a server yourself.
 */
export class App {
  readonly name: string;
  readonly version: string;
  readonly runtime: Runtime;
  readonly dev: boolean;
  readonly log: Logger;
  readonly tests: RouteTest[] = [];
  readonly plugins: Plugin[];
  /**
   * Bun reads this from the default export to enable WebSockets (listen() passes it too), with
   * the limits from `miu({ websocket })`.
   */
  readonly websocket: ReturnType<typeof bunWebSocketHandler>;

  private options: MiuOptions;
  private routers = new Map<string, Router<Compiled>>();
  /** `routers.get("GET")`, kept in a field: most requests are GETs and skip the Map lookup. */
  private getRouter: Router<Compiled> | undefined = undefined;
  private compiled: Compiled[] = [];
  private pending: RouteDef[] = [];
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private requestHooks: NonNullable<Plugin["onRequest"]>[] = [];
  private responseHooks: NonNullable<Plugin["onResponse"]>[] = [];
  private errorHooks: NonNullable<Plugin["onError"]>[] = [];
  private background = new Set<Promise<unknown>>();
  private services = new Map<string, unknown>();
  private suggestKeys: string[] | undefined;
  private stopping: Promise<void> | undefined;
  private maxBodySize: number;
  private workers: { queue: WorkersHandler[]; scheduled: WorkersHandler[] } = { queue: [], scheduled: [] };
  private staticEnv: Record<string, unknown>;
  private logRequests: boolean;
  /** No onResponse hooks and no request logging (set in init): responses need no finishing. */
  private plainAfter = false;
  private basePlatform: PlatformInfo;
  private serverPlatform: PlatformInfo | null = null;
  /**
   * The platform for requests Bun.serve hands to `fetch` directly. Only `fetch` uses it (public
   * `dispatch` swaps it for `serverPlatform`), so its identity marks a Response that goes
   * straight to the wire: string results then skip `content-type` and Bun adds
   * `text/plain;charset=utf-8` itself, saving ~110–130 ns per text response.
   */
  private wirePlatform: PlatformInfo | null = null;
  /** The Bun server `fetch` saw last and the platform it maps to (wirePlatform or serverPlatform). */
  private lastServer: unknown = undefined;
  private lastServerPlatform: PlatformInfo | null = null;
  private toolCache: { routeTools: ReturnType<typeof buildRouteTool>[]; pluginTools: McpTool[] } | null = null;

  constructor(options: MiuOptions = {}) {
    this.options = options;
    this.name = options.name ?? "miujs-app";
    this.version = options.version ?? "0.0.0";
    this.runtime = detectRuntime();
    this.dev = options.dev ?? defaultDev(this.runtime);
    this.log = createLogger(options.logLevel ?? (this.dev ? "info" : "warn"), { app: this.name });
    this.logRequests = options.logRequests ?? false;
    this.maxBodySize = options.maxBodySize ?? 10 * 1024 * 1024;
    this.websocket = bunWebSocketHandler(resolveWebSocketLimits(options.websocket));
    this.plugins = options.plugins ?? [];
    this.staticEnv = this.runtime === "workerd" ? {} : processEnv();
    this.basePlatform = { runtime: this.runtime, pending: this.background, trustProxy: options.trustProxy, wsMaxPayload: this.websocket.maxPayloadLength };
    for (const src of options.routes ?? []) this.collect(src, undefined);
    for (const p of this.plugins) for (const r of p.routes ?? []) this.collect(r, undefined);
  }

  /** Add routes before the first request (plugins call this from `setup`). */
  add(...sources: RouteSource[]): this {
    if (this.isReady) throw errors.config("MIU_E_APP_STARTED", "Routes cannot be added after the app has started", "Add routes in `miu({ routes })` or in a plugin's `setup`.");
    for (const s of sources) this.collect(s, undefined);
    return this;
  }

  /** Register a Cloudflare Workers `queue` or `scheduled` handler. */
  on(event: "queue" | "scheduled", handler: WorkersHandler): this {
    this.workers[event].push(handler);
    return this;
  }

  ready(): Promise<void> {
    return (this.readyPromise ??= this.init());
  }

  private collect(src: RouteSource, hint: string | undefined): void {
    if (isRoute(src)) {
      if (!src.name && hint) src.name = hint;
      this.pending.push(src);
      return;
    }
    if (Array.isArray(src)) {
      for (const s of src) this.collect(s, undefined);
      return;
    }
    if (src && typeof src === "object") {
      for (const [key, value] of Object.entries(src)) {
        if (key === "tests" && value && typeof value === "object" && !isRoute(value)) {
          for (const [name, fn] of Object.entries(value as Record<string, unknown>)) {
            if (typeof fn === "function") this.tests.push({ name, fn: fn as RouteTest["fn"] });
          }
        } else if (isRoute(value) || Array.isArray(value)) {
          this.collect(value as RouteSource, key === "default" ? undefined : key);
        }
      }
    }
  }

  private async init(): Promise<void> {
    for (const p of this.plugins) {
      if (p.setup) await p.setup(this);
      if (p.onRequest) this.requestHooks.push(p.onRequest.bind(p));
      if (p.onResponse) this.responseHooks.push(p.onResponse.bind(p));
      if (p.onError) this.errorHooks.push(p.onError.bind(p));
    }
    this.plainAfter = this.responseHooks.length === 0 && !this.logRequests;
    const names = new Set<string>();
    for (const def of this.pending) {
      const c = this.compile(def);
      if (names.has(c.name)) {
        throw errors.config("MIU_E_ROUTE_NAME_DUPLICATE", `Two routes are named "${c.name}"`, "Give one of them a different `name`, or export it under a different name.");
      }
      names.add(c.name);
      this.register(c);
    }
    this.registerInternal();
    const mcp = this.options.mcp;
    if (mcp) {
      const { routeTools, pluginTools } = this.mcpTools(typeof mcp === "object" ? mcp : {});
      const seen = new Map<string, string>();
      const owners = [...routeTools.map((t) => [t.tool.name, `route ${t.route.name}`]), ...pluginTools.map((t) => [t.name, `plugin tool ${t.name}`])];
      for (const [tool, owner] of owners) {
        const prev = seen.get(tool);
        if (prev) {
          throw errors.config("MIU_E_MCP_TOOL_DUPLICATE", `MCP tool name "${tool}" is used by ${prev} and ${owner}`, "Rename one of them (route `name`), or exclude one with `mcp: false`. Tool names keep only letters, digits, _ and -.");
        }
        seen.set(tool, owner);
      }
      for (const t of pluginTools) {
        if (t.auth !== undefined && !isAuthRequirement(t.auth)) {
          throw errors.config("MIU_E_AUTH_INVALID", `MCP tool ${t.name} has auth: ${JSON.stringify(t.auth)}, which is not a valid requirement`, 'Use auth: "required", "optional", false, or { role: "admin" } (a string or an array of roles).');
        }
      }
    }
    this.isReady = true;
  }

  private register(c: Compiled): void {
    let r = this.routers.get(c.method);
    if (!r) this.routers.set(c.method, (r = new Router()));
    if (c.method === "GET") this.getRouter = r;
    r.add(c.path, c);
    if (c.def && !c.def.config.internal) this.compiled.push(c);
  }

  private compile(def: RouteDef): Compiled {
    const cfg = def.config;
    const path = normalizePath(def.path);
    const name = def.name ?? cfg.name ?? deriveName(def.method, path);
    const P = cfg.params as Schema | undefined;
    const Q = cfg.query as Schema | undefined;
    const B = cfg.body as Schema | undefined;
    const R = this.dev ? (cfg.response as Schema | undefined) : undefined;

    if (P && P.json.type === "object") {
      const inPath = pathParams(path);
      const keys = Object.keys((P.json.properties as object) ?? {});
      const unknown = keys.find((k) => !inPath.includes(k));
      if (unknown) {
        throw errors.config("MIU_E_PARAM_UNKNOWN", `Route ${def.method} ${path} declares params.${unknown}, but the path has no :${unknown}`, `Add :${unknown} to the path or remove it from the params schema.`);
      }
      const missing = inPath.find((k) => !keys.includes(k));
      if (missing) {
        throw errors.config("MIU_E_PARAM_MISSING", `Route ${def.method} ${path} has :${missing} in the path, but the params schema does not declare it`, `Add ${missing}: t.string() (or another type) to the params schema.`);
      }
    }

    if (Q && Q.json.type === "object") {
      const shadow = Object.keys((Q.json.properties as object) ?? {}).find((k) => pathParams(path).includes(k));
      if (shadow) {
        throw errors.config("MIU_E_PARAM_SHADOWED", `Route ${def.method} ${path} has "${shadow}" both as a path param and a query key`, `Rename the query key (e.g. "${shadow}Filter") so the two can't be confused.`);
      }
    }

    const auth = (cfg.auth ?? false) as AuthRequirement;
    // Fail closed: an unknown value (`true`, a typo, `{ roles }`) must never compile to a public route.
    if (!isAuthRequirement(auth)) {
      throw errors.config(
        "MIU_E_AUTH_INVALID",
        `Route ${def.method} ${path} has auth: ${JSON.stringify(auth)}, which is not a valid requirement`,
        'Use auth: "required", "optional", false, or { role: "admin" } (a string or an array of roles).',
      );
    }
    const roles = typeof auth === "object" && auth ? ([] as string[]).concat(auth.role) : null;
    const needsUser = auth === "required" || roles !== null;
    const status = cfg.status ?? 200;
    const handler = cfg.handler as (ctx: any) => unknown;

    const respond = this.responder(status, R);
    // Stays synchronous unless the body must be read or the handler returns a promise:
    // every avoided `await` is a microtask saved on the hot path.
    const callHandler = (ctx: RequestContext): Response | Promise<Response> => {
      const result = handler(ctx) as any;
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        return result.then((r: unknown) => respond(r, ctx));
      }
      return respond(result, ctx);
    };
    const permission = cfg.permission;
    const bodyLimit = cfg.maxBodySize ?? this.maxBodySize;

    // Specialization by closure selection (no code generation, which Workers forbid): a route
    // with no auth, permission, query or body runs only the steps it has. Router params checked
    // by a plain `t.object({ k: t.string() })` need no check at all: the router yields one string
    // per declared key (compile() verified the keys match the path), so parsing would return an
    // equal object. Skipped only when no onRequest hook can replace ctx.params first, and only
    // when the schema's key order is the router's (it writes the deepest param first), so
    // `Object.keys(params)` is unchanged.
    const skipParams =
      P !== undefined && this.requestHooks.length === 0 && isPlainStringObject(P) && Object.keys(P.json.properties as object).join("/") === pathParams(path).reverse().join("/");
    if (!needsUser && permission === undefined && !Q && !B) {
      const fast: Compiled["run"] =
        P === undefined || skipParams
          ? callHandler
          : (ctx) => {
              ctx.params = check(P, ctx.params, "params", true);
              return callHandler(ctx);
            };
      const info: RouteInfo = { name, method: def.method, path, auth, tags: cfg.tags ?? [], config: cfg };
      return { name, method: def.method, path, def, info, run: fast };
    }

    const validated = (ctx: RequestContext): Response | Promise<Response> => {
      if (P) ctx.params = check(P, ctx.params, "params", true);
      if (Q) ctx.query = check(Q, ctx.query, "query", true);
      if (B) {
        return readBody(ctx.req, bodyLimit).then(({ value, form }) => {
          ctx.body = check(B, value, "body", form);
          return callHandler(ctx);
        });
      }
      return callHandler(ctx);
    };
    const run = (ctx: RequestContext): Response | Promise<Response> => {
      if (needsUser) {
        const user = ctx.user as { roles?: string[] } | undefined;
        if (!user) throw errors.unauthorized();
        if (roles && !roles.some((r) => user.roles?.includes(r))) {
          throw errors.forbidden(`Requires role: ${roles.join(" or ")}`, "Sign in as a user with the required role.");
        }
      }
      if (permission !== undefined) {
        const authorize = (ctx as unknown as { authorize?: (p: string) => unknown }).authorize;
        if (typeof authorize !== "function") {
          // Never allow silently: a permission nobody checks is a hole.
          throw errors.config(
            "MIU_E_PERMISSION_UNCHECKED",
            `Route ${def.method} ${path} requires permission "${permission}", but no plugin provides ctx.authorize`,
            "Add an access plugin such as access({ roles }) from @miujs/access, or remove `permission` from the route.",
          );
        }
        const r = authorize.call(ctx, permission) as { then?: unknown } | undefined;
        if (r && typeof r.then === "function") return (r as Promise<unknown>).then(() => validated(ctx));
      }
      return validated(ctx);
    };

    const info: RouteInfo = { name, method: def.method, path, auth, tags: cfg.tags ?? [], config: cfg };
    return { name, method: def.method, path, def, info, run };
  }

  /**
   * A route's result → Response function. Text results with no `ctx.set` take a per-route fast
   * path: straight to Bun's server they skip `content-type` (see toResponse); otherwise a text
   * equal to the previous one is served as a `clone()` of a cached Response, which on Bun costs
   * ~60 ns less than building a Response with a headers init. A clone has its own headers and
   * body, so callers can read and change it freely. Long texts skip the cache (cloning them costs
   * more than building them).
   */
  private responder(status: number, R: Schema | undefined): (result: unknown, ctx: RequestContext) => Response {
    const init: ResponseInit = status === 200 ? TEXT_INIT : { status, headers: TEXT_HEADERS };
    let lastText: string | undefined;
    let template: Response | null = null;
    return (result, ctx) => {
      if (typeof result !== "string" || ctx._hasSet) return this.toResponse(result, ctx, status, R);
      if (ctx._platform === this.wirePlatform && this.responseHooks.length === 0 && ctx.method !== "HEAD") {
        return status === 200 ? new Response(result) : new Response(result, { status });
      }
      if (result.length > TEMPLATE_MAX) return new Response(result, init);
      if (result === lastText) return (template ??= new Response(result, init)).clone();
      lastText = result;
      template = null;
      return new Response(result, init);
    };
  }

  private toResponse(result: unknown, ctx: RequestContext, status: number, R: Schema | undefined): Response {
    // Fast path for the common case, a plain object with no `ctx.set` and no response schema:
    // it skips the `instanceof` chain below.
    if (typeof result === "object" && result !== null && Object.getPrototypeOf(result) === Object.prototype && status === 200 && R === undefined && !ctx._hasSet) {
      return Response.json(result);
    }
    if (result instanceof Response) return result;
    const hasSet = ctx._hasSet;
    const st = hasSet && ctx.set.status ? ctx.set.status : status;
    const headers = hasSet ? ctx.set.headers : undefined;
    if (result === undefined || result === null) {
      return new Response(null, { status: st === 200 ? 204 : st, headers });
    }
    if (typeof result === "string") {
      // Straight to Bun's server and nobody can see the object (no onResponse hook; not HEAD, whose
      // body is stripped and which gets no header from Bun): let Bun add the content-type on the wire.
      if (!headers && ctx._platform === this.wirePlatform && this.responseHooks.length === 0 && ctx.method !== "HEAD") {
        return st === 200 ? new Response(result) : new Response(result, { status: st });
      }
      if (!headers) return new Response(result, st === 200 ? TEXT_INIT : { status: st, headers: TEXT_HEADERS });
      if (!headers.has("content-type")) headers.set("content-type", TEXT_TYPE);
      return new Response(result, { status: st, headers });
    }
    if (result instanceof Uint8Array || result instanceof ArrayBuffer || result instanceof ReadableStream) {
      return new Response(result as BodyInit, { status: st, headers });
    }
    if (R) check(R, result, "response", false);
    if (!headers && st === 200) return Response.json(result);
    if (headers && !headers.has("content-type")) headers.set("content-type", JSON_TYPE);
    return new Response(JSON.stringify(result), { status: st, headers: headers ?? JSON_HEADERS });
  }

  private registerInternal(): void {
    const internal = (method: string, path: string, run: Compiled["run"]) =>
      this.register({ name: `_miu${path}`, method, path, def: null, info: { name: `_miu${path}`, method, path, auth: false, tags: ["internal"] }, run });

    if (this.dev) {
      internal("GET", "/_miu/app.json", async () => Response.json(this.inspect()));
    }
    const oa = this.options.openapi ?? this.dev;
    if (oa) {
      const path = (typeof oa === "object" && oa.path) || "/_miu/openapi.json";
      internal("GET", path, async () => Response.json(this.openapi()));
    }
    const mcp = this.options.mcp;
    if (mcp) {
      const opts: McpOptions = typeof mcp === "object" ? mcp : {};
      const handler = createMcpHandler(
        {
          name: this.name,
          version: this.version,
          dev: this.dev,
          maxBodySize: this.maxBodySize,
          readText: readTextLimited,
          tools: () => this.mcpTools(opts),
          dispatch: async (r, ctx) => this.dispatch(r, (ctx as unknown as RequestContext).env, (ctx as unknown as RequestContext)._platform),
        },
        opts,
      );
      const path = opts.path ?? "/mcp";
      for (const m of ["POST", "GET", "DELETE"]) internal(m, path, (ctx) => handler(ctx as unknown as Context));
    }
  }

  private mcpTools(opts: McpOptions) {
    if (this.toolCache) return this.toolCache;
    const routeTools = this.described()
      .filter((r) => r.def.config.mcp !== false && (!opts.include || opts.include(r)))
      .map(buildRouteTool);
    const pluginTools = this.plugins.flatMap((p) => p.mcpTools?.() ?? []);
    return (this.toolCache = { routeTools, pluginTools });
  }

  private described(): DescribedRoute[] {
    return this.compiled.map((c) => ({ name: c.name, method: c.method, path: c.path, def: c.def! }));
  }

  /**
   * The fetch handler. Signature covers Workers `(req, env, ctx)`, Bun `(req, server)` and
   * Deno `(req, info)`.
   */
  fetch = (req: Request, envOrServer?: any, executionContext?: any): Response | Promise<Response> => {
    if (this.runtime === "workerd") {
      return this.dispatch(req, envOrServer ?? {}, { runtime: this.runtime, executionContext, wsMaxPayload: this.websocket.maxPayloadLength });
    }
    // Off Workers the platform object only varies with Bun's server, so it is reused, not
    // allocated per request. The same server as last time skips the checks below.
    if (envOrServer === undefined) return this.dispatchCore(req, this.staticEnv, this.basePlatform);
    if (envOrServer === this.lastServer) return this.dispatchCore(req, this.staticEnv, this.lastServerPlatform!);
    let platform = this.basePlatform;
    if (envOrServer && typeof envOrServer.upgrade === "function") {
      let sp = this.serverPlatform;
      if (sp === null || sp.bunServer !== envOrServer) {
        this.serverPlatform = sp = { runtime: this.runtime, bunServer: envOrServer, pending: this.background, trustProxy: this.options.trustProxy };
        this.wirePlatform = this.runtime === "bun" && isBunServer(envOrServer) ? { ...sp } : null;
      }
      platform = this.wirePlatform ?? sp;
      this.lastServer = envOrServer;
      this.lastServerPlatform = platform;
    } else if (envOrServer && envOrServer.remoteAddr && typeof envOrServer.remoteAddr.hostname === "string") {
      // Deno.serve info, or the Node adapter: the client address for ctx.ip.
      platform = { runtime: this.runtime, pending: this.background, remoteAddr: envOrServer.remoteAddr, trustProxy: this.options.trustProxy, wsMaxPayload: this.websocket.maxPayloadLength };
    }
    return this.dispatchCore(req, this.staticEnv, platform);
  };

  /** Handle a request without the network. Used by tests, MCP tool calls and adapters. */
  dispatch(req: Request, env: unknown, platform: PlatformInfo): Response | Promise<Response> {
    // Callers here read the Response (MCP, plugins re-dispatching with ctx._platform), so never
    // the wire-only platform: their string responses keep the content-type.
    if (platform === this.wirePlatform && this.serverPlatform !== null) platform = this.serverPlatform;
    return this.dispatchCore(req, env, platform);
  }

  private dispatchCore(req: Request, env: unknown, platform: PlatformInfo): Response | Promise<Response> {
    if (!this.isReady) return this.ready().then(() => this.dispatchCore(req, env, platform));
    const start = this.logRequests ? performance.now() : 0;
    const method = req.method;
    const path = pathOf(req.url);
    // `lookup` writes path params straight into this object, which becomes `ctx.params`.
    const params: Record<string, string> = {};
    let match = (method === "GET" ? this.getRouter : this.routers.get(method))?.lookup(path, params);
    let head = false;
    if (match === undefined && method === "HEAD") {
      match = this.getRouter?.lookup(path, params);
      head = match !== undefined;
    }
    const ctx = new RequestContext(req, method, path, params, match === undefined ? null : match.info, env, platform, this.log);
    let out: Response | Promise<Response>;
    try {
      // runMatch inlined for the common case (no hooks, matched, not HEAD).
      out = this.requestHooks.length !== 0 || head || match === undefined ? (this.requestHooks.length ? this.routeWithHooks(ctx, match, head) : this.runMatch(ctx, match, head)) : match.run(ctx);
    } catch (err) {
      out = this.errorResponse(err, ctx);
    }
    if (out instanceof Promise) {
      return out.then(
        (res) => this.after(ctx, res, start),
        (err) => this.after(ctx, this.errorResponse(err, ctx), start),
      );
    }
    if (ctx._setCookies === null && this.plainAfter && !ctx._upgraded) return out;
    return this.after(ctx, out, start);
  }

  private after(ctx: RequestContext, res: Response, start: number): Response | Promise<Response> {
    if (ctx._upgraded) return undefined as unknown as Response; // Bun took over the socket.
    if (ctx._setCookies === null && this.responseHooks.length === 0 && !this.logRequests) return res;
    return this.finalize(ctx, res).then((final) => {
      if (this.logRequests) {
        ctx.log.info("request", { route: ctx.route?.name ?? null, status: final.status, ms: Math.round((performance.now() - start) * 100) / 100 });
      }
      return final;
    });
  }

  private async routeWithHooks(ctx: RequestContext, match: Compiled | undefined, head: boolean): Promise<Response> {
    for (const hook of this.requestHooks) {
      const r = await hook(ctx as unknown as Context);
      if (r instanceof Response) return r;
    }
    return this.runMatch(ctx, match, head);
  }

  private runMatch(ctx: RequestContext, match: Compiled | undefined, head: boolean): Response | Promise<Response> {
    if (match === undefined) return this.notMatched(ctx);
    const res = match.run(ctx);
    if (!head) return res;
    const strip = (r: Response) => new Response(null, { status: r.status, headers: r.headers });
    return res instanceof Promise ? res.then(strip) : strip(res);
  }

  private notMatched(ctx: RequestContext): Response {
    const allowed: string[] = [];
    for (const [m, r] of this.routers) if (r.find(ctx.path)) allowed.push(m);
    if (allowed.includes("GET") && !allowed.includes("HEAD")) allowed.push("HEAD");
    allowed.sort((a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b));
    if (allowed.length) {
      if (ctx.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: allowed.join(", ") } });
      return errors
        .custom({
          code: "MIU_E_METHOD_NOT_ALLOWED",
          status: 405,
          message: `${ctx.method} is not allowed on ${ctx.path}`,
          fix: `Use one of: ${allowed.join(", ")}.`,
        })
        .toResponse({ allow: allowed.join(", ") });
    }
    // Suggestions cost O(path × route length) per route, so only real typos get them: long paths
    // (scanners, garbage) and routes of very different length are skipped. Keeps 404s cheap.
    let best: { d: number; label: string } | null = null;
    const path = ctx.path;
    const maxD = Math.max(3, path.length / 3);
    if (path.length <= MAX_SUGGEST_PATH) {
      const keys = (this.suggestKeys ??= this.compiled.map((c) => c.path.replace(/:[^/]+/g, "x")));
      for (let i = 0; i < keys.length; i++) {
        if (Math.abs(keys[i].length - path.length) > maxD) continue;
        const d = levenshtein(path, keys[i]);
        if (!best || d < best.d) best = { d, label: `${this.compiled[i].method} ${this.compiled[i].path}` };
      }
    }
    const fix =
      best && best.d <= maxD
        ? `Did you mean ${best.label}? Run \`miu inspect\` or GET /_miu/app.json in dev to list routes.`
        : "Run `miu inspect` or GET /_miu/app.json in dev to list routes.";
    const shown = path.length > MAX_SUGGEST_PATH ? `${path.slice(0, MAX_SUGGEST_PATH)}…` : path;
    return errors.custom({ code: "MIU_E_ROUTE_NOT_FOUND", status: 404, message: `No route for ${ctx.method} ${shown}`, fix }).toResponse();
  }

  private errorResponse(err: unknown, ctx: RequestContext): Response {
    for (const hook of this.errorHooks) {
      // Observers only: a failing or slow hook never changes or delays the response.
      try {
        const r = hook(ctx as unknown as Context, err) as Promise<void> | void;
        if (r && typeof r.catch === "function") r.catch((e) => ctx.log.error("onError hook failed", { err: e }));
      } catch (e) {
        ctx.log.error("onError hook failed", { err: e });
      }
    }
    if (isMiuError(err)) {
      if (err.status >= 500) ctx.log.error(err.message, { code: err.code, err });
      return err.toResponse();
    }
    ctx.log.error("unhandled error", { err, route: ctx.route?.name });
    const message = this.dev && err instanceof Error ? err.message : "Internal server error";
    const details = this.dev && err instanceof Error ? { name: err.name, stack: err.stack?.split("\n").slice(0, 8) } : undefined;
    return new MiuError({
      code: "MIU_E_INTERNAL",
      status: 500,
      message,
      fix: this.dev ? "See the stack in details and the server log." : undefined,
      details,
    }).toResponse();
  }

  private async finalize(ctx: RequestContext, res: Response): Promise<Response> {
    for (const hook of this.responseHooks) {
      try {
        const r = await hook(ctx as unknown as Context, res);
        if (r instanceof Response) res = r;
      } catch (err) {
        res = this.errorResponse(err, ctx);
      }
    }
    // Cookies go on last, so response hooks (e.g. sessions) can still set them.
    if (ctx._setCookies) {
      try {
        for (const c of ctx._setCookies) res.headers.append("set-cookie", c);
      } catch {
        // Immutable headers (e.g. a Response from fetch()): copy first.
        res = new Response(res.body, res);
        for (const c of ctx._setCookies) res.headers.append("set-cookie", c);
      }
    }
    return res;
  }

  /** Cloudflare Workers queue consumer entry. */
  queue = async (batch: unknown, env: unknown, ctx: unknown): Promise<void> => {
    await this.ready();
    for (const h of this.workers.queue) await h(batch, env, ctx, this);
  };

  /** Cloudflare Workers cron entry. */
  scheduled = async (controller: unknown, env: unknown, ctx: unknown): Promise<void> => {
    await this.ready();
    for (const h of this.workers.scheduled) await h(controller, env, ctx, this);
  };

  /** Port used by Bun's auto-serve and `listen()`: $PORT or 3000. */
  get port(): number {
    return Number(this.staticEnv.PORT) || 3000;
  }

  /** Start an HTTP server on Bun, Deno or Node. */
  async listen(port: number = this.port, hostname?: string): Promise<{ port: number; url: string; stop(): Promise<void> }> {
    await this.ready();
    const g = globalThis as any;
    let server: { port: number; url: string; stop(): Promise<void> };
    if (this.runtime === "bun") {
      const s = g.Bun.serve({ port, hostname, fetch: this.fetch, websocket: this.websocket, maxRequestBodySize: this.maxRequestBodySize });
      server = { port: s.port, url: String(s.url), stop: async () => void s.stop(true) };
    } else if (this.runtime === "deno") {
      const s = g.Deno.serve({ port, hostname, onListen() {} }, (r: Request, info: unknown) => this.fetch(r, info));
      server = { port: s.addr.port, url: `http://${hostname ?? "localhost"}:${s.addr.port}/`, stop: () => s.shutdown() };
    } else if (this.runtime === "node") {
      // A variable specifier keeps bundlers (wrangler/esbuild) from pulling node:http into Workers builds.
      const nodeAdapter = "./node.ts";
      const { serveNode } = (await import(/* @vite-ignore */ nodeAdapter)) as typeof import("./node.ts");
      server = await serveNode(this, { port, hostname });
    } else {
      throw errors.config("MIU_E_LISTEN_UNSUPPORTED", `listen() is not available on ${this.runtime}`, "On Cloudflare Workers, `export default app` instead of calling listen().");
    }
    this.log.info(`MiuJS listening on ${server.url}`);
    const closeServer = server.stop;
    // Stopping the server stops the app too: plugins release timers and sockets, and
    // background work finishes, so the process can exit.
    server.stop = async () => {
      await closeServer();
      await this.close();
    };
    return server;
  }

  /**
   * Shut the app down: waits for `ctx.waitUntil` work, then calls each plugin's `stop()` in
   * reverse order (a failing one is logged and the rest still run). Safe to call more than once.
   */
  close(): Promise<void> {
    return (this.stopping ??= (async () => {
      await this.drain();
      for (const p of [...this.plugins].reverse()) {
        if (!p.stop) continue;
        try {
          await p.stop();
        } catch (err) {
          this.log.error("plugin stop failed", { plugin: p.name, err });
        }
      }
    })());
  }

  /**
   * The app's routes as tools, the same ones MCP serves, for model tool-use (`@miujs/ai`), agents
   * and scripts. Works without `mcp` on. `call` dispatches a real request, so auth, permissions
   * and validation apply; pass the caller's headers to act as them. Call after `ready()`.
   */
  tools(): AppTool[] {
    if (!this.isReady) throw errors.config("MIU_E_APP_NOT_READY", "app.tools() was called before the app was ready", "Call `await app.ready()` first.");
    return this.described()
      .filter((r) => r.def.config.mcp !== false)
      .map((r) => {
        const rt = buildRouteTool(r);
        const call = async (args: Record<string, unknown> = {}, opts: { headers?: HeadersLike; env?: unknown; origin?: string } = {}) => {
          let res: Response;
          try {
            const req = routeToolRequest(rt, args, opts.origin ?? "http://localhost", new Headers(opts.headers));
            res = await this.dispatch(req, opts.env ?? this.staticEnv, this.basePlatform);
          } catch (err) {
            if (!isMiuError(err)) throw err;
            res = err.toResponse(); // e.g. a dot-segment path argument
          }
          const text = await res.text();
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {}
          return { ok: res.ok, status: res.status, body, text };
        };
        return { name: rt.tool.name, title: rt.tool.title, description: rt.tool.description, inputSchema: rt.tool.inputSchema, outputSchema: rt.tool.outputSchema, annotations: rt.tool.annotations, route: r.name, call };
      });
  }

  /** Register a shared service (call from a plugin's `setup`). Each name can be provided once. */
  provide<K extends keyof Services & string>(name: K, value: Services[K]): this;
  provide(name: string, value: unknown): this;
  provide(name: string, value: unknown): this {
    if (this.services.has(name)) {
      throw errors.config("MIU_E_SERVICE_DUPLICATE", `Service "${name}" is provided twice`, "Only one plugin may provide each service. Remove the duplicate plugin or rename one service.");
    }
    this.services.set(name, value);
    return this;
  }

  /** A service a plugin provided. Works in jobs, workflows and scripts, not only requests. */
  service<K extends keyof Services & string>(name: K): Services[K];
  service<T = unknown>(name: string): T;
  service(name: string): unknown {
    if (!this.services.has(name)) {
      throw errors.config("MIU_E_SERVICE_MISSING", `No plugin provides the "${name}" service`, `Add the plugin that provides "${name}" to miu({ plugins }), and call app.service() after \`await app.ready()\`.`);
    }
    return this.services.get(name);
  }

  hasService(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * The largest body any route accepts. Bun reads this from the default export (and listen()
   * passes it), so the server refuses bigger bodies before the app reads them.
   */
  get maxRequestBodySize(): number {
    let max = this.maxBodySize;
    for (const d of this.pending) if (d.config.maxBodySize !== undefined && d.config.maxBodySize > max) max = d.config.maxBodySize;
    return max;
  }

  /**
   * Wait for background work started with ctx.waitUntil (off Workers), e.g. before shutdown or
   * at the end of a test. Work started while draining is waited for too.
   */
  async drain(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /** Send a request through the app without a network. */
  request = async (input: string | Request, init?: RequestInit): Promise<Response> => {
    const r = typeof input === "string" ? new Request(new URL(input, "http://localhost"), init) : input;
    return this.dispatch(r, this.staticEnv, this.basePlatform);
  };

  /** Call a route by its definition. Fills the path, query and JSON body for you. */
  call: CallFn = async (route, input = {}) => {
    let path = normalizePath(route.path);
    for (const [k, v] of Object.entries(input.params ?? {})) {
      path = path.replace(new RegExp(`[:*]${k}(?=/|$)`), encodeURIComponent(String(v)));
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(input.query ?? {})) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, String(x));
      else if (v !== undefined) qs.append(k, String(v));
    }
    const headers = new Headers(input.headers);
    let body: string | undefined;
    if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    const q = qs.toString();
    const res = await this.request(path + (q ? `?${q}` : ""), { method: route.method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {}
    const out: TestResponse = {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text,
      body: parsed,
      expectStatus(expected) {
        if (res.status !== expected) throw new Error(`expected status ${expected}, got ${res.status}: ${text.slice(0, 300)}`);
        return out;
      },
    };
    return out;
  };

  routes(): { name: string; method: string; path: string }[] {
    return this.compiled.map((c) => ({ name: c.name, method: c.method, path: c.path }));
  }

  openapi(): Record<string, unknown> {
    const oa = this.options.openapi;
    const info = { title: this.name, version: this.version, ...(typeof oa === "object" ? oa.info : {}) };
    return generateOpenApi(this.described(), info);
  }

  /** Everything an agent needs to understand this app, as JSON. Call after `ready()`. */
  inspect() {
    const mcp = this.options.mcp;
    return {
      name: this.name,
      version: this.version,
      runtime: this.runtime,
      dev: this.dev,
      routes: this.compiled.map((c) => {
        const cfg = c.def!.config;
        return {
          name: c.name,
          method: c.method,
          path: c.path,
          summary: cfg.summary,
          auth: cfg.auth ?? false,
          permission: cfg.permission,
          tags: cfg.tags ?? [],
          params: cfg.params?.json,
          query: cfg.query?.json,
          body: cfg.body?.json,
          response: cfg.response?.json,
        };
      }),
      plugins: this.plugins.map((p) => ({ name: p.name, info: p.inspect?.() })),
      mcp: mcp ? { path: (typeof mcp === "object" && mcp.path) || "/mcp", tools: this.mcpTools(typeof mcp === "object" ? mcp : {}).routeTools.map((t) => t.tool.name) } : null,
      tests: this.tests.map((x) => x.name),
      cloudflare: this.cloudflareNeeds(),
    };
  }

  private cloudflareNeeds() {
    const uniq = (xs: string[]) => [...new Set(xs)];
    const all = this.plugins.map((p) => p.cloudflare?.() ?? {});
    const dos = new Map<string, { binding: string; className: string }>();
    for (const n of all) for (const d of n.durableObjects ?? []) dos.set(d.binding, d);
    const byBinding = <T extends { binding: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.binding, x])).values()];
    let assets: (NonNullable<CloudflareNeeds["assets"]> & { binding: string }) | undefined;
    for (const n of all) {
      if (!n.assets) continue;
      const next = { binding: "ASSETS", ...n.assets };
      if (assets && assets.directory !== next.directory) {
        throw errors.config(
          "MIU_E_CLOUDFLARE_ASSETS_CONFLICT",
          `Two plugins serve static assets from different folders: ${assets.directory} and ${next.directory}`,
          "Workers has one static assets folder per app. Build everything into one folder, or serve only one plugin's assets.",
        );
      }
      assets ??= next;
    }
    const cpuMs = Math.max(0, ...all.map((n) => n.limits?.cpuMs ?? 0));
    return {
      assets,
      workflows: byBinding(all.flatMap((n) => n.workflows ?? [])),
      ratelimits: byBinding(all.flatMap((n) => n.ratelimits ?? [])),
      ai: all.find((n) => n.ai)?.ai,
      vectorize: byBinding(all.flatMap((n) => n.vectorize ?? [])),
      hyperdrive: byBinding(all.flatMap((n) => n.hyperdrive ?? [])),
      kv: uniq(all.flatMap((n) => n.kv ?? [])),
      d1: uniq(all.flatMap((n) => n.d1 ?? [])),
      r2: uniq(all.flatMap((n) => n.r2 ?? [])),
      queues: {
        producers: uniq(all.flatMap((n) => n.queues?.producers ?? [])),
        consumers: uniq(all.flatMap((n) => n.queues?.consumers ?? [])),
      },
      durableObjects: [...dos.values()],
      crons: uniq(all.flatMap((n) => n.crons ?? [])),
      limits: cpuMs > 0 ? { cpuMs } : undefined,
    };
  }
}

/** Create an app. */
export function miu(options: MiuOptions = {}): App {
  return new App(options);
}
