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
  query = {} as I["query"] extends undefined ? Record<string, string | string[]> : I["query"];
  body = undefined as I["body"];
  /** The final response; set after the handler runs. Middleware may read or mutate it after `next()`. */
  res!: Response;

  private _url?: URL;
  private _status = 200;
  private _headers?: Headers;
  private _vars?: Map<string, unknown>;
  private _cookies?: Record<string, string>;

  constructor(req: Request, env?: Bindings<E>, executionCtx?: ExecutionContext) {
    this.req = req;
    this.env = (env ?? {}) as Bindings<E>;
    this.executionCtx = executionCtx;
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
    const h = new Headers(headers);
    h.set("content-type", "application/json; charset=utf-8");
    return this.newResponse(JSON.stringify(data), status, h);
  }

  text(text: string, status?: number, headers?: HeadersInit): Response {
    const h = new Headers(headers);
    h.set("content-type", "text/plain; charset=utf-8");
    return this.newResponse(text, status, h);
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
