import { Router } from "./router.ts";
import { Context, addValue, type Env, type ExecutionContext } from "./context.ts";
import { HttpError, ValidationError, problem } from "./errors.ts";
import { validate, type AnySchema, type Infer, type Issue, type Result } from "./schema.ts";
import { isBunServer, isUpgradeRequest, publishTopic, upgradeRequired, upgradeWebSocket } from "../realtime/upgrade.ts";
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
  S extends AnySchema | undefined = AnySchema | undefined,
> {
  params?: P;
  query?: Q;
  body?: B;
  headers?: H;
  /** Schema of a successful response; documented in OpenAPI and MCP, and the typed client's result type. */
  response?: S;
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
  /** Route declares params/query/headers/body schemas, so input must be parsed and validated. */
  needsInput: boolean;
}

const needsInput = (m: RouteMeta) => !!(m.params || m.query || m.headers || m.body);

export interface MiuOptions {
  /** Log unexpected (500) errors with console.error. Default true. */
  logger?: boolean;
  /** Application name and version, used by OpenAPI and MCP. */
  name?: string;
  version?: string;
  description?: string;
}

// ---------- route table types (used by `createClient<typeof app>()`; erased at runtime) ----------

/** Client-facing types of one route: what to send and what comes back. */
export interface Endpoint<P = unknown, Q = unknown, B = unknown, O = unknown> {
  params: P;
  query: Q;
  body: B;
  output: O;
}

/** Route table accumulated on the app type: path -> method (`GET`, ..., `ALL`) -> Endpoint. */
export type RouteSchema = { [path: string]: { [method: string]: Endpoint } };

type TrimEnd<P extends string> = P extends `${infer X}/` ? (X extends "" ? "/" : X) : P;
/** Type-level twin of `normalize()`: leading slash, no trailing slash. */
export type NormalizePath<P extends string> = TrimEnd<P extends `/${string}` ? P : `/${P}`>;
type JoinPath<A extends string, B extends string> = A extends "/" ? B : B extends "/" ? A : `${A}${B}`;

type PathParamNames<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | PathParamNames<Tail>
    : Rest
  : never;
/** `:name` segments of a path (and `path` for a trailing `*`), as the client sends them. */
export type PathParams<P extends string> = {
  [K in PathParamNames<P> | (P extends `${string}*` ? "path" : never)]: string | number;
};

/** What the client receives: `Response` is opaque (unknown), no content is void. */
type HandlerOutput<T> = 0 extends 1 & T
  ? any
  : [T] extends [Response]
    ? unknown
    : [T] extends [undefined | void]
      ? void
      : Exclude<T, Response>;

type EndpointOf<Path extends string, P, Q, B, S, Ret> = Endpoint<
  P extends AnySchema ? Infer<P> : PathParams<Path>,
  Q extends AnySchema ? Infer<Q> : Record<string, unknown>,
  B extends AnySchema ? Infer<B> : unknown,
  S extends AnySchema ? Infer<S> : HandlerOutput<Awaited<Ret>>
>;

type AddRoute<R, Path extends string, M extends string, EP> = R & { [K in NormalizePath<Path>]: { [X in M]: EP } };

/** Routes of a mounted sub-app, re-keyed under `prefix`. */
export type PrefixRoutes<Prefix extends string, SR> = {
  [K in keyof SR & string as JoinPath<NormalizePath<Prefix>, K>]: SR[K];
};

type Opt = AnySchema | undefined;

type RouteFn<E extends Env, R extends RouteSchema, M extends string> = {
  <Path extends string, P extends Opt = undefined, Q extends Opt = undefined, B extends Opt = undefined, H extends Opt = undefined, S extends Opt = undefined, Ret = unknown>(
    path: Path,
    meta: RouteMeta<P, Q, B, H, S>,
    handler: (c: Context<E, RouteInput<P, Q, B, H>>) => Ret,
  ): Miu<E, AddRoute<R, Path, M, EndpointOf<Path, P, Q, B, S, Ret>>>;
  <Path extends string, Ret = unknown>(
    path: Path,
    handler: (c: Context<E, RouteInput<undefined, undefined, undefined, undefined>>) => Ret,
  ): Miu<E, AddRoute<R, Path, M, EndpointOf<Path, undefined, undefined, undefined, undefined, Ret>>>;
};

export class Miu<E extends Env = Env, R extends RouteSchema = {}> {
  /** Type-only route table for `createClient<typeof app>()`; never set at runtime. */
  declare readonly "~routes": R;
  readonly config: MiuOptions;
  readonly routes: Route[] = [];
  private middleware: MountedMiddleware[] = [];
  private router = new Router<Compiled>();
  private wsRouter = new Router<Compiled>();
  private hasWs = false;
  private errorHandler?: ErrorHandler<E>;
  private notFoundHandler?: (c: Context<E>) => Response | Promise<Response>;

  constructor(options: MiuOptions = {}) {
    this.config = { logger: true, name: "miu-app", version: "0.0.0", ...options };
  }

  get: RouteFn<E, R, "GET"> = (path: string, a: any, b?: any): any => this.on("GET", path, a, b);
  post: RouteFn<E, R, "POST"> = (path: string, a: any, b?: any): any => this.on("POST", path, a, b);
  put: RouteFn<E, R, "PUT"> = (path: string, a: any, b?: any): any => this.on("PUT", path, a, b);
  patch: RouteFn<E, R, "PATCH"> = (path: string, a: any, b?: any): any => this.on("PATCH", path, a, b);
  delete: RouteFn<E, R, "DELETE"> = (path: string, a: any, b?: any): any => this.on("DELETE", path, a, b);
  options: RouteFn<E, R, "OPTIONS"> = (path: string, a: any, b?: any): any => this.on("OPTIONS", path, a, b);
  all: RouteFn<E, R, "ALL"> = (path: string, a: any, b?: any): any => this.on("ALL", path, a, b);

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
    this.wsRouter.add("WS", route.path, { route, middleware: meta.use ?? [], needsInput: needsInput(meta) });
    this.hasWs = true;
    return this;
  }

  /** Bun `websocket` handler, so `export default app` serves WebSockets too. */
  get websocket(): typeof bunWebSocket {
    return bunWebSocket;
  }

  /**
   * Send to every WebSocket subscribed to `topic` (via `ws.subscribe`).
   * Strings and binary go as-is; other values as JSON. Bun and Node reach the
   * whole server; Workers reach this isolate only (use `MiuRoom` across isolates).
   */
  publish(topic: string, data: unknown): void {
    publishTopic(this, topic, data);
  }

  on(method: Method, path: string, metaOrHandler: RouteMeta | Handler<E, any>, maybeHandler?: Handler<E, any>): this {
    const meta = typeof metaOrHandler === "function" ? {} : metaOrHandler;
    const handler = typeof metaOrHandler === "function" ? metaOrHandler : maybeHandler;
    if (!handler) throw new Error(`Missing handler for ${method} ${path}`);
    const route: Route = { method, path: normalize(path), meta, handler };
    this.routes.push(route);
    this.router.add(method, route.path, { route, middleware: meta.use ?? [], needsInput: needsInput(meta) });
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
  route<Prefix extends string, SR extends RouteSchema>(prefix: Prefix, sub: Miu<any, SR>): Miu<E, R & PrefixRoutes<Prefix, SR>>;
  route(prefix: string, sub: Miu<any, any>): this {
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
      const match =
        (this.hasWs && isUpgradeRequest(req) && this.wsRouter.find("WS", path)) || this.router.find(method, path);
      let chain: Middleware[] | undefined;
      for (const m of this.middleware) if (!m.match || m.match(path)) (chain ??= []).push(m.fn);
      let final: Middleware;
      if (match) {
        c.params = match.params as any;
        if (match.handler.middleware.length) (chain ??= []).push(...match.handler.middleware);
        const route = match.handler.route;
        const needsInput = match.handler.needsInput;
        if (!chain && !route.ws) {
          // Fast path: no middleware. Skip the compose machinery entirely.
          if (needsInput) await prepareInput(c, route.meta);
          const out = route.handler(c);
          c.res = c.respond(out instanceof Promise ? await out : out);
          return method === "HEAD" ? headOnly(c.res) : c.res;
        }
        final = async (ctx) => {
          if (needsInput) await prepareInput(ctx, route.meta);
          if (route.ws) return upgradeWebSocket(ctx, route.meta, route.ws, server);
          const out = route.handler(ctx);
          return ctx.respond(out instanceof Promise ? await out : out);
        };
      } else if (this.hasWs && this.wsRouter.find("WS", path)) {
        final = () => upgradeRequired();
      } else {
        final = (ctx) => this.handleNotFound(ctx, path);
      }
      await compose(c, chain ?? [], final, (err, ctx) => this.handleError(err, ctx));
    } catch (err) {
      c.res = await this.handleError(err, c);
    }
    return method === "HEAD" ? headOnly(c.res) : c.res;
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
  // Built-in schemas validate synchronously; only Standard Schemas may return a Promise.
  const run = (where: string, schema: AnySchema, raw: unknown, coerce: boolean): unknown | Promise<unknown> => {
    const v = validate(schema, raw, { coerce });
    return v instanceof Promise ? v.then((r) => take(where, r)) : take(where, v);
  };
  const take = (where: string, r: Result): unknown => {
    if (r.ok) return r.value;
    for (const i of r.issues) issues.push({ path: [where, ...i.path], message: i.message });
    return undefined;
  };
  let v: unknown;
  if (meta.params) {
    v = run("params", meta.params, c.params, true);
    c.params = (v instanceof Promise ? await v : v) as any;
  }
  if (meta.query) {
    v = run("query", meta.query, c.query, true);
    c.query = (v instanceof Promise ? await v : v) as any;
  }
  if (meta.headers) {
    const h: Record<string, string> = {};
    c.req.headers.forEach((val, k) => (h[k] = val));
    v = run("headers", meta.headers, h, true);
    (c as any).headers = v instanceof Promise ? await v : v;
  }
  if (meta.body) {
    const { value, form } = await readBody(c.req);
    v = run("body", meta.body, value, form);
    c.body = v instanceof Promise ? await v : v;
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

function headOnly(res: Response): Response {
  return res.body ? new Response(null, { status: res.status, headers: res.headers }) : res;
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
