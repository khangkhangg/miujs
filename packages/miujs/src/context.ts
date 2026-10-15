import { parseCookies, serializeCookie, type CookieOptions, type Cookies } from "./cookies.ts";
import type { Logger } from "./logger.ts";
import type { Runtime } from "./runtime.ts";
import type { WebSocketHandlers } from "./websocket.ts";

/**
 * Environment variables and platform bindings (D1, KV, R2, Queues, Durable Objects on Cloudflare).
 * Augment it to get typed bindings:
 *
 * ```ts
 * declare module "miujs" { interface Env { DB: D1Database; SESSION_SECRET: string } }
 * ```
 */
export interface Env {
  [key: string]: unknown;
}

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  roles: string[];
  [key: string]: unknown;
}

/** Information about the matched route, available to plugins and handlers. */
export interface RouteInfo {
  name: string;
  method: string;
  path: string;
  auth: unknown;
  tags: string[];
}

/**
 * The object every handler and plugin hook receives. Plugins add fields through module
 * augmentation, e.g. `declare module "miujs" { interface Context { cache: CacheClient } }`.
 */
export interface Context {
  /** The raw web-standard request. */
  readonly req: Request;
  readonly method: string;
  /** URL path without the query string, e.g. `/users/42`. */
  readonly path: string;
  /** Parsed URL (created on first access). */
  readonly url: URL;
  readonly headers: Headers;
  /**
   * Client IP address when the runtime knows it: Cloudflare's `cf-connecting-ip` on Workers, the
   * socket address on Bun. `undefined` otherwise (in-process calls, Deno/Node for now). Never read
   * from client-controlled headers such as X-Forwarded-For.
   */
  readonly ip: string | undefined;
  /** Path parameters. Typed and validated when the route has a `params` schema. */
  params: any;
  /** Query parameters. Typed and validated when the route has a `query` schema. */
  query: any;
  /** Request body. Present and validated when the route has a `body` schema. */
  body: any;
  /** Signed-in user, set by `@miujs/auth`. */
  user?: AuthUser;
  env: Env;
  readonly runtime: Runtime;
  readonly requestId: string;
  readonly log: Logger;
  readonly cookies: Cookies;
  /** Status and headers for the response when the handler returns plain data. */
  readonly set: { status: number; headers: Headers };
  /** Matched route, or `null` for 404s. */
  readonly route: RouteInfo | null;
  /** Free-form per-request storage for plugins. */
  readonly state: Record<string, unknown>;
  /** Keep work running after the response is sent (`ctx.waitUntil` on Workers). */
  waitUntil(promise: Promise<unknown>): void;
  /** Accept a WebSocket on this request. Return the result from your handler. */
  upgrade(handlers: WebSocketHandlers): Response;
}

export interface PlatformInfo {
  runtime: Runtime;
  /** Bun's `Server`, when running on Bun. */
  bunServer?: { upgrade(req: Request, opts: { data: unknown }): boolean; requestIP?(req: Request): { address: string } | null };
  /** Workers' ExecutionContext. */
  executionContext?: { waitUntil(p: Promise<unknown>): void; passThroughOnException?(): void };
}

/** Fast path extraction without building a URL object. */
export function pathOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2);
  if (start === -1) return "/";
  // One pass to the first `?` or `#`, instead of two `indexOf`s that each scan the query string.
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 63 /* ? */ || c === 35 /* # */) return url.slice(start, i);
  }
  return url.slice(start);
}

export function parseQuery(url: string): Record<string, string | string[]> {
  const q = url.indexOf("?");
  const out: Record<string, string | string[]> = {};
  if (q === -1) return out;
  const hash = url.indexOf("#", q);
  const search = new URLSearchParams(hash === -1 ? url.slice(q + 1) : url.slice(q + 1, hash));
  for (const [k, v] of search) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else out[k] = [prev, v];
  }
  return out;
}

let counter = 0;

/** Concrete context. Lazy fields keep per-request cost low when a handler doesn't use them. */
export class RequestContext {
  readonly req: Request;
  readonly method: string;
  readonly path: string;
  readonly runtime: string;
  params: any;
  body: any = undefined;
  user: unknown = undefined;
  env: any;
  route: RouteInfo | null = null;
  /** @internal set when Bun took over the connection for a WebSocket. */
  _upgraded = false;
  /** @internal */
  _platform: PlatformInfo;
  /** @internal */
  _setCookies: string[] | null = null;
  /** @internal */
  _baseLog: Logger;

  private _url: URL | undefined;
  private _query: any;
  private _cookies: Cookies | undefined;
  private _set: { status: number; headers: Headers } | undefined;
  private _state: Record<string, unknown> | undefined;
  private _requestId: string | undefined;
  private _log: Logger | undefined;

  constructor(req: Request, path: string, env: unknown, platform: PlatformInfo, log: Logger) {
    this.req = req;
    this.method = req.method;
    this.path = path;
    this.env = env;
    this.params = {};
    this._platform = platform;
    this.runtime = platform.runtime;
    this._baseLog = log;
  }

  get url(): URL {
    return (this._url ??= new URL(this.req.url));
  }
  get headers(): Headers {
    return this.req.headers;
  }
  get ip(): string | undefined {
    const p = this._platform;
    if (p.runtime === "workerd") return this.req.headers.get("cf-connecting-ip") ?? undefined;
    return p.bunServer?.requestIP?.(this.req)?.address;
  }
  get query(): any {
    return (this._query ??= parseQuery(this.req.url));
  }
  set query(v: any) {
    this._query = v;
  }
  get requestId(): string {
    if (this._requestId === undefined) {
      this._requestId = this.req.headers.get("x-request-id") ?? `${Date.now().toString(36)}-${(++counter).toString(36)}`;
    }
    return this._requestId;
  }
  get log(): Logger {
    return (this._log ??= this._baseLog.child({ requestId: this.requestId, method: this.method, path: this.path }));
  }
  get state(): Record<string, unknown> {
    return (this._state ??= {});
  }
  get set(): { status: number; headers: Headers } {
    return (this._set ??= { status: 0, headers: new Headers() });
  }
  /** @internal true when the handler touched `ctx.set`. */
  get _hasSet(): boolean {
    return this._set !== undefined;
  }
  get cookies(): Cookies {
    if (this._cookies) return this._cookies;
    let parsed: Record<string, string> | undefined;
    const read = () => (parsed ??= parseCookies(this.req.headers.get("cookie")));
    const push = (c: string) => (this._setCookies ??= []).push(c);
    return (this._cookies = {
      get: (name) => read()[name],
      all: () => ({ ...read() }),
      set: (name, value, opts?: CookieOptions) => {
        read()[name] = value;
        push(serializeCookie(name, value, opts));
      },
      delete: (name, opts) => {
        delete read()[name];
        push(serializeCookie(name, "", { ...opts, maxAge: 0, expires: new Date(0) }));
      },
    });
  }

  waitUntil(promise: Promise<unknown>): void {
    const ec = this._platform.executionContext;
    const guarded = promise.catch((err) => this.log.error("waitUntil task failed", { err }));
    if (ec) ec.waitUntil(guarded);
  }

  upgrade(handlers: WebSocketHandlers): Response {
    // Implemented in websocket.ts to keep runtime-specific code in one place.
    return upgradeImpl(this, handlers);
  }
}

// Set by websocket.ts at module load (avoids an import cycle).
let upgradeImpl: (ctx: RequestContext, handlers: WebSocketHandlers) => Response = () => {
  throw new Error("websocket support not loaded");
};
export function _setUpgradeImpl(fn: typeof upgradeImpl) {
  upgradeImpl = fn;
}
