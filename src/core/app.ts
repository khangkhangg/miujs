import { Router } from "./router.ts";
import { Context, type Env, type ExecutionContext } from "./context.ts";
import { HttpError, ValidationError, problem } from "./errors.ts";
import { validate, type AnySchema, type Infer, type Issue } from "./schema.ts";
import { isBunServer, isUpgradeRequest, upgradeRequired, upgradeWebSocket } from "../realtime/upgrade.ts";
import { bunWebSocket, type BunServerLike } from "../realtime/bun.ts";
import type { WsForward, WsHandlers } from "../realtime/types.ts";

export type Next = () => Promise<void>;
export type Middleware<E extends Env = any> = (c: Context<E, any>, next: Next) => unknown | Promise<unknown>;
export type Handler<E extends Env, I extends object> = (c: Context<E, I>) => unknown | Promise<unknown>;
export type ErrorHandler<E extends Env> = (err: unknown, c: Context<E, any>) => Response | Promise<Response>;

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
/** `WS` marks WebSocket routes registered with `app.ws()`. */
export type Method = (typeof METHODS)[number] | "ALL" | "WS";

export interface ToolOptions {
  name?: string;
  description?: string;
}

export interface RouteMeta<
  P extends AnySchema | undefined = AnySchema | undefined,
  Q extends AnySchema | undefined = AnySchema | undefined,
  B extends AnySchema | undefined = AnySchema | undefined,
  H extends AnySchema | undefined = AnySchema | undefined,
> {
  params?: P;
  query?: Q;
  body?: B;
  headers?: H;
  /** Schema of a successful response; documented in OpenAPI and MCP. */
  response?: AnySchema;
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
  /** Expose as an MCP tool (default true). Pass an object to rename/describe it. */
  tool?: boolean | ToolOptions;
  /** Hide from OpenAPI (default false). */
  hidden?: boolean;
  /** Middleware that runs only for this route, after global middleware. */
  use?: Middleware[];
}

type Out<S> = S extends AnySchema ? Infer<S> : undefined;

export interface RouteInput<P, Q, B, H> {
  params: P extends AnySchema ? Infer<P> : Record<string, string>;
  query: Q extends AnySchema ? Infer<Q> : Record<string, string | string[]>;
  body: Out<B>;
  headers: Out<H>;
}

export interface Route {
  method: Method;
  path: string;
  meta: RouteMeta;
  handler: Handler<any, any>;
  /** WebSocket handlers (or an upgrade-forwarding function) for `WS` routes. */
  ws?: WsHandlers<any> | WsForward;
}

/** Meta for `app.ws()`: params/query/headers validation, middleware, and the `upgrade` hook. */
export interface WsMeta<
  E extends Env = any,
  P extends AnySchema | undefined = AnySchema | undefined,
  Q extends AnySchema | undefined = AnySchema | undefined,
  H extends AnySchema | undefined = AnySchema | undefined,
  D = unknown,
> extends Pick<RouteMeta<P, Q, undefined, H>, "params" | "query" | "headers" | "summary" | "description" | "tags" | "use"> {
  /**
   * Runs after middleware and validation, before the upgrade. Its return value
   * becomes `ws.data`; return or throw a Response/HttpError to reject.
   */
  upgrade?: (c: Context<E, RouteInput<P, Q, undefined, H>>) => D | Response | Promise<D | Response>;
}

interface MountedMiddleware {
  match: ((path: string) => boolean) | null;
  pattern: string | null;
  fn: Middleware;
}

interface Compiled {
  route: Route;
  middleware: Middleware[];
}

export interface MiuOptions {
  /** Log unexpected (500) errors with console.error. Default true. */
  logger?: boolean;
  /** Application name and version, used by OpenAPI and MCP. */
  name?: string;
  version?: string;
  description?: string;
}

type RouteFn<E extends Env, Self> = {
  <P extends AnySchema | undefined = undefined, Q extends AnySchema | undefined = undefined, B extends AnySchema | undefined = undefined, H extends AnySchema | undefined = undefined>(
    path: string,
    meta: RouteMeta<P, Q, B, H>,
    handler: Handler<E, RouteInput<P, Q, B, H>>,
  ): Self;
  (path: string, handler: Handler<E, RouteInput<undefined, undefined, undefined, undefined>>): Self;
};

export class Miu<E extends Env = Env> {
  readonly config: MiuOptions;
  readonly routes: Route[] = [];
  private middleware: MountedMiddleware[] = [];
  private router = new Router<Compiled>();
  private wsRouter = new Router<Compiled>();
  private errorHandler?: ErrorHandler<E>;
  private notFoundHandler?: (c: Context<E>) => Response | Promise<Response>;

  constructor(options: MiuOptions = {}) {
    this.config = { logger: true, name: "miu-app", version: "0.0.0", ...options };
  }

  get: RouteFn<E, this> = (path: string, a: any, b?: any) => this.on("GET", path, a, b);
  post: RouteFn<E, this> = (path: string, a: any, b?: any) => this.on("POST", path, a, b);
  put: RouteFn<E, this> = (path: string, a: any, b?: any) => this.on("PUT", path, a, b);
  patch: RouteFn<E, this> = (path: string, a: any, b?: any) => this.on("PATCH", path, a, b);
  delete: RouteFn<E, this> = (path: string, a: any, b?: any) => this.on("DELETE", path, a, b);
  options: RouteFn<E, this> = (path: string, a: any, b?: any) => this.on("OPTIONS", path, a, b);
  all: RouteFn<E, this> = (path: string, a: any, b?: any) => this.on("ALL", path, a, b);

  /**
   * Register a WebSocket route. Middleware and validation run before the
   * upgrade; plain requests get 426. Never exposed via OpenAPI or MCP.
   */
  ws<P extends AnySchema | undefined = undefined, Q extends AnySchema | undefined = undefined, H extends AnySchema | undefined = undefined, D = undefined>(
    path: string,
    meta: WsMeta<E, P, Q, H, D>,
    handlers: WsHandlers<Exclude<Awaited<D>, Response>> | WsForward,
  ): this;
  ws(path: string, handlers: WsHandlers<undefined> | WsForward): this;
  ws(path: string, a: any, b?: any): this {
    const handlers = b ?? a;
    const meta: RouteMeta = { ...(b ? a : {}), tool: false, hidden: true };
    const route: Route = { method: "WS", path: normalize(path), meta, handler: upgradeRequired, ws: handlers };
    this.routes.push(route);
    this.wsRouter.add("WS", route.path, { route, middleware: meta.use ?? [] });
    return this;
  }

  /** Bun `websocket` handler, so `export default app` serves WebSockets too. */
  get websocket(): typeof bunWebSocket {
    return bunWebSocket;
  }

  on(method: Method, path: string, metaOrHandler: RouteMeta | Handler<E, any>, maybeHandler?: Handler<E, any>): this {
    const meta = typeof metaOrHandler === "function" ? {} : metaOrHandler;
    const handler = typeof metaOrHandler === "function" ? metaOrHandler : maybeHandler;
    if (!handler) throw new Error(`Missing handler for ${method} ${path}`);
    const route: Route = { method, path: normalize(path), meta, handler };
    this.routes.push(route);
    this.router.add(method, route.path, { route, middleware: meta.use ?? [] });
    return this;
  }

  /** Register middleware globally, or for paths matching a pattern like `/admin/*`. */
  use(fn: Middleware<E>): this;
  use(pattern: string, fn: Middleware<E>): this;
  use(a: string | Middleware<E>, b?: Middleware<E>): this {
    if (typeof a === "function") this.middleware.push({ match: null, pattern: null, fn: a });
    else this.middleware.push({ match: compilePattern(a), pattern: a, fn: b! });
    return this;
  }

  /** Mount another app's routes and middleware under a prefix. */
  route(prefix: string, sub: Miu<any>): this {
    const base = normalize(prefix);
    const join = (p: string) => normalize(base === "/" ? p : p === "/" ? base : base + p);
    for (const m of sub.middleware) {
      const pattern = join(m.pattern ?? "/*");
      this.middleware.push({ match: compilePattern(pattern), pattern, fn: m.fn });
    }
    for (const r of sub.routes) {
      if (r.ws) this.ws(join(r.path), r.meta as WsMeta, r.ws as WsHandlers);
      else this.on(r.method, join(r.path), r.meta, r.handler);
    }
    return this;
  }

  onError(fn: ErrorHandler<E>): this {
    this.errorHandler = fn;
    return this;
  }

  notFound(fn: (c: Context<E>) => Response | Promise<Response>): this {
    this.notFoundHandler = fn;
    return this;
  }

  /** Web-standard entry point. Works as a Bun, Deno, Cloudflare Workers or Vercel handler. */
  fetch = async (req: Request, env?: E["Bindings"], executionCtx?: ExecutionContext): Promise<Response> => {
    // Bun calls fetch(req, server): keep the server for WebSocket upgrades, not as env.
    let server: BunServerLike | undefined;
    if (isBunServer(env)) {
      server = env;
      env = undefined;
    }
    const c = new Context<E>(req, env as any, executionCtx);
    c.app = this;
    const path = pathOf(req.url);
    const method = req.method;
    try {
      const match = (isUpgradeRequest(req) && this.wsRouter.find("WS", path)) || this.router.find(method, path);
      const chain: Middleware[] = [];
      for (const m of this.middleware) if (!m.match || m.match(path)) chain.push(m.fn);
      let final: Middleware;
      if (match) {
        c.params = match.params as any;
        chain.push(...match.handler.middleware);
        const route = match.handler.route;
        final = async (ctx) => {
          await prepareInput(ctx, route.meta);
          if (route.ws) return upgradeWebSocket(ctx, route.meta, route.ws, server);
          return ctx.respond(await route.handler(ctx));
        };
      } else if (this.wsRouter.find("WS", path)) {
        final = () => upgradeRequired();
      } else {
        final = (ctx) => this.handleNotFound(ctx, path);
      }
      await compose(c, chain, final, (err, ctx) => this.handleError(err, ctx));
    } catch (err) {
      c.res = await this.handleError(err, c);
    }
    if (method === "HEAD" && c.res.body) {
      return new Response(null, { status: c.res.status, headers: c.res.headers });
    }
    return c.res;
  };

  /** Convenience for tests and in-process calls (used by the MCP bridge). */
  request(input: string | Request, init?: RequestInit, env?: E["Bindings"], executionCtx?: ExecutionContext) {
    const req = typeof input === "string" ? new Request(new URL(input, "http://localhost"), init) : input;
    return this.fetch(req, env, executionCtx);
  }

  /** Start an HTTP server on Bun. On Node use `serve()` from `miujs/node`. */
  listen(port = 3000, hostname?: string) {
    const B = (globalThis as { Bun?: { serve: (o: object) => unknown } }).Bun;
    if (!B) throw new Error("app.listen() requires Bun. On Node, use `import { serve } from 'miujs/node'`.");
    return B.serve({ port, hostname, fetch: this.fetch, websocket: this.websocket }) as { port: number; stop: (force?: boolean) => void };
  }

  private async handleNotFound(c: Context<E>, path: string): Promise<Response> {
    const allowed = this.router.allowedMethods(path);
    if (allowed.length) {
      if (allowed.includes("GET") && !allowed.includes("HEAD")) allowed.push("HEAD");
      return problem(405, { detail: `Method ${c.method} not allowed` }, { allow: allowed.join(", ") });
    }
    if (this.notFoundHandler) return this.notFoundHandler(c);
    return problem(404, { detail: `No route for ${c.method} ${path}` });
  }

  private async handleError(err: unknown, c: Context<E>): Promise<Response> {
    if (this.errorHandler) {
      try {
        return await this.errorHandler(err, c);
      } catch (inner) {
        err = inner;
      }
    }
    if (err instanceof HttpError) return err.toResponse();
    if (this.config.logger) console.error("[miu] Unhandled error:", err);
    return problem(500);
  }
}

/**
 * Run middleware in onion order. A thrown error becomes a response at the
 * level it was thrown, so outer middleware still runs its post-`next()` code
 * (CORS, request ids, logging) on error responses.
 */
async function compose(
  c: Context<any, any>,
  chain: Middleware[],
  final: Middleware,
  onError: (err: unknown, c: Context<any, any>) => Promise<Response>,
): Promise<void> {
  const dispatch = async (i: number): Promise<void> => {
    const fn = i < chain.length ? chain[i]! : i === chain.length ? final : null;
    if (!fn) return;
    let nextCalled = false;
    let out: unknown;
    try {
      out = await fn(c, () => {
        if (nextCalled) throw new Error("next() called multiple times");
        nextCalled = true;
        return dispatch(i + 1);
      });
    } catch (err) {
      c.res = await onError(err, c);
      return;
    }
    if (out instanceof Response) c.res = out;
    else if (!nextCalled && !c.res && fn !== final) {
      throw new Error("Middleware must call next() or return a Response");
    }
  };
  await dispatch(0);
}

async function prepareInput(c: Context<any, any>, meta: RouteMeta): Promise<void> {
  const issues: Issue[] = [];
  const run = async (where: string, schema: AnySchema | undefined, raw: unknown, coerce: boolean) => {
    if (!schema) return raw;
    const r = await validate(schema, raw, { coerce });
    if (r.ok) return r.value;
    for (const i of r.issues) issues.push({ path: [where, ...i.path], message: i.message });
    return undefined;
  };

  c.params = await run("params", meta.params, c.params, true);
  c.query = await run("query", meta.query, searchToObject(c.url.searchParams), true);
  if (meta.headers) {
    const h: Record<string, string> = {};
    c.req.headers.forEach((v, k) => (h[k] = v));
    (c as any).headers = await run("headers", meta.headers, h, true);
  }
  if (meta.body) {
    const { value, form } = await readBody(c.req);
    c.body = await run("body", meta.body, value, form);
  }
  if (issues.length) throw new ValidationError(issues);
}

async function readBody(req: Request): Promise<{ value: unknown; form: boolean }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const fd = await req.formData().catch(() => {
      throw new HttpError(400, "Malformed form body");
    });
    const obj: Record<string, unknown> = {};
    for (const [k, v] of fd as unknown as Iterable<[string, unknown]>) addValue(obj, k.endsWith("[]") ? k.slice(0, -2) : k, v);
    return { value: obj, form: true };
  }
  const text = await req.text();
  if (!text) return { value: undefined, form: false };
  if (type === "" || type.includes("json")) {
    try {
      return { value: JSON.parse(text), form: false };
    } catch {
      throw new HttpError(400, "Malformed JSON body", { code: "invalid_json" });
    }
  }
  throw new HttpError(415, `Unsupported content-type: ${type}`);
}

function searchToObject(sp: URLSearchParams): Record<string, string | string[]> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of sp) addValue(obj, k.endsWith("[]") ? k.slice(0, -2) : k, v);
  return obj as Record<string, string | string[]>;
}

function addValue(obj: Record<string, unknown>, k: string, v: unknown) {
  const cur = obj[k];
  if (cur === undefined) obj[k] = v;
  else if (Array.isArray(cur)) cur.push(v);
  else obj[k] = [cur, v];
}

function pathOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2);
  if (start < 0) return "/";
  let end = url.length;
  const q = url.indexOf("?", start);
  if (q >= 0) end = q;
  const h = url.indexOf("#", start);
  if (h >= 0 && h < end) end = h;
  return url.slice(start, end);
}

function normalize(path: string): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function compilePattern(pattern: string): (path: string) => boolean {
  const p = normalize(pattern);
  if (p === "/*" || p === "*") return () => true;
  const re = new RegExp(
    "^" +
      p
        .split("/")
        .map((seg) => (seg === "*" ? ".*" : seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/")
        .replace(/\/\.\*$/, "(?:/.*)?") +
      "/?$",
  );
  return (path) => re.test(path);
}
