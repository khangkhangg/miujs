/** Client IPs for in-process sub-requests (e.g. MCP tool calls), keyed by Request — never by header. */
const innerClientIps = new WeakMap<Request, string>();

/**
 * Attribute an in-process sub-request to the original client, so `c.ip` (rate limits, logs) stays the
 * caller's address. Framework-internal: only code that builds the Request can call it.
 */
export function setClientIp(req: Request, ip: string | undefined): void {
  if (ip) innerClientIps.set(req, ip);
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface AppLike {
  readonly routes: readonly { method: string; path: string; meta: Record<string, any> }[];
  readonly config: { name?: string; version?: string; description?: string };
  fetch(req: Request, env?: any, executionCtx?: ExecutionContext): Promise<Response>;
}

export interface Env {
  Bindings?: object;
  Variables?: object;
}

export interface Input {
  params?: unknown;
  query?: unknown;
  body?: unknown;
  headers?: unknown;
}

type Bindings<E extends Env> = E["Bindings"] extends object ? E["Bindings"] : Record<string, unknown>;
type Vars<E extends Env> = E["Variables"] extends object ? E["Variables"] : Record<string, unknown>;

export interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Per-request context. Handlers can return plain values (auto-serialized)
 * or use the helpers here for full control.
 */
export class Context<E extends Env = Env, I extends Input = Input> {
  readonly req: Request;
  readonly env: Bindings<E>;
  readonly executionCtx?: ExecutionContext;
  /** The top-level app handling this request (used by plugins such as mcp() and openapi()). */
  app!: AppLike;
  params = {} as I["params"] extends undefined ? Record<string, string> : I["params"];
  private _query?: unknown;
  body = undefined as I["body"];
  /** The final response; set after the handler runs. Middleware may read or mutate it after `next()`. */
  res!: Response;
  /** The matched route (method, path, meta), when one matched. For logging and tooling. */
  route?: { method: string; path: string; meta: Record<string, any> };
  /** The error thrown while handling this request, if any (the response is already rendered from it). */
  error?: unknown;

  private _url?: URL;
  private _status = 200;
  private _headers?: Headers;
  private _vars?: Map<string, unknown>;
  private _cookies?: Record<string, string>;

  /** The serving runtime (Bun server / Node adapter); set by the app. Used for `ip`. */
  peer?: { requestIP?(req: Request): { address: string } | null | undefined };

  /**
   * The client's socket address as seen by the server (Bun, Node adapter). Undefined for in-process
   * requests and on Cloudflare Workers (use the trusted `cf-connecting-ip` header there). Never derived
   * from client-controlled headers.
   */
  get ip(): string | undefined {
    return this.peer?.requestIP?.(this.req)?.address || innerClientIps.get(this.req) || undefined;
  }

  constructor(req: Request, env?: Bindings<E>, executionCtx?: ExecutionContext) {
    this.req = req;
    this.env = (env ?? {}) as Bindings<E>;
    this.executionCtx = executionCtx;
  }

  /** Query string as an object (repeated keys become arrays). Parsed lazily unless a route schema validated it. */
  get query(): I["query"] extends undefined ? Record<string, string | string[]> : I["query"] {
    if (this._query === undefined) {
      const url = this.req.url;
      const q = url.indexOf("?");
      this._query = q < 0 ? {} : searchToObject(new URLSearchParams(url.slice(q + 1, hashIndex(url, q))));
    }
    return this._query as any;
  }
  set query(value) {
    this._query = value;
  }

  /** No status or headers were set on this context, so a response can use runtime defaults. */
  get pristine(): boolean {
    return !this._headers && this._status === 200;
  }

  get url(): URL {
    return (this._url ??= new URL(this.req.url));
  }

  get method(): string {
    return this.req.method;
  }

  // ----- request-scoped variables -----
  set<K extends keyof Vars<E> & string>(key: K, value: Vars<E>[K]): void {
    (this._vars ??= new Map()).set(key, value);
  }
  get<K extends keyof Vars<E> & string>(key: K): Vars<E>[K] {
    return this._vars?.get(key) as Vars<E>[K];
  }

  // ----- request helpers -----
  cookie(name: string): string | undefined {
    if (!this._cookies) {
      this._cookies = {};
      for (const part of (this.req.headers.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (k && !(k in this._cookies)) {
          const v = part.slice(i + 1).trim();
          try {
            this._cookies[k] = decodeURIComponent(v);
          } catch {
            this._cookies[k] = v;
          }
        }
      }
    }
    return this._cookies[name];
  }

  // ----- response helpers -----
  status(code: number): this {
    this._status = code;
    return this;
  }

  header(name: string, value: string, opts: { append?: boolean } = {}): this {
    const h = (this._headers ??= new Headers());
    if (opts.append) h.append(name, value);
    else h.set(name, value);
    return this;
  }

  setCookie(name: string, value: string, o: CookieOptions = {}): this {
    let s = `${name}=${encodeURIComponent(value)}`;
    if (o.maxAge !== undefined) s += `; Max-Age=${Math.floor(o.maxAge)}`;
    if (o.domain) s += `; Domain=${o.domain}`;
    if (o.path) s += `; Path=${o.path}`;
    if (o.expires) s += `; Expires=${o.expires.toUTCString()}`;
    if (o.httpOnly) s += "; HttpOnly";
    if (o.secure) s += "; Secure";
    if (o.sameSite) s += `; SameSite=${o.sameSite}`;
    return this.header("set-cookie", s, { append: true });
  }

  deleteCookie(name: string, o: Omit<CookieOptions, "maxAge" | "expires"> = {}): this {
    return this.setCookie(name, "", { ...o, maxAge: 0 });
  }

  newResponse(body: BodyInit | null, status = this._status, headers?: HeadersInit): Response {
    if (!this._headers) return new Response(body, { status, headers });
    const h = new Headers(headers);
    if (this._headers) {
      for (const [k, v] of this._headers) {
        if (k === "set-cookie") continue;
        if (!h.has(k)) h.set(k, v);
      }
      for (const c of this._headers.getSetCookie()) h.append("set-cookie", c);
    }
    return new Response(body, { status, headers: h });
  }

  json(data: unknown, status?: number, headers?: HeadersInit): Response {
    // Native Response.json (application/json;charset=utf-8) is the fast path when nothing custom is set.
    if (!headers && !this._headers) {
      const st = status ?? this._status;
      return st === 200 ? Response.json(data) : Response.json(data, { status: st });
    }
    return this.newResponse(JSON.stringify(data), status, withType(headers, JSON_TYPE));
  }

  text(text: string, status?: number, headers?: HeadersInit): Response {
    return this.newResponse(text, status, withType(headers, TEXT_TYPE));
  }

  html(html: string, status?: number, headers?: HeadersInit): Response {
    const h = new Headers(headers);
    h.set("content-type", "text/html; charset=utf-8");
    return this.newResponse(html, status, h);
  }

  redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
    return this.newResponse(null, status, { location });
  }

  /** Turn whatever a handler returned into a Response. */
  respond(value: unknown): Response {
    if (value instanceof Response) {
      if (!this._headers) return value;
      const merged = this.newResponse(value.body, value.status, value.headers);
      return merged;
    }
    if (value === undefined) return this.newResponse(null, this._status === 200 ? 204 : this._status);
    if (typeof value === "string") return this.text(value);
    if (value instanceof ReadableStream || value instanceof ArrayBuffer || value instanceof Uint8Array || value instanceof Blob) {
      return this.newResponse(value as BodyInit);
    }
    return this.json(value);
  }
}

const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };
const TEXT_TYPE = { "content-type": "text/plain; charset=utf-8" };

/** Content-type plus caller headers; a shared literal on the common no-extra-headers path. */
function withType(headers: HeadersInit | undefined, type: { "content-type": string }): HeadersInit {
  if (!headers) return type;
  const h = new Headers(headers);
  h.set("content-type", type["content-type"]);
  return h;
}

function hashIndex(url: string, from: number): number {
  const h = url.indexOf("#", from);
  return h < 0 ? url.length : h;
}

/** URLSearchParams to an object; repeated keys (and `key[]`) become arrays. */
export function searchToObject(sp: URLSearchParams): Record<string, string | string[]> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of sp) addValue(obj, k.endsWith("[]") ? k.slice(0, -2) : k, v);
  return obj as Record<string, string | string[]>;
}

export function addValue(obj: Record<string, unknown>, k: string, v: unknown) {
  const cur = obj[k];
  if (cur === undefined) obj[k] = v;
  else if (Array.isArray(cur)) cur.push(v);
  else obj[k] = [cur, v];
}
