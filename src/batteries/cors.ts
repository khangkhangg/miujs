import type { Context } from "../core/context.ts";
import type { Middleware } from "../core/app.ts";
import { appendToken, resHeaders } from "./internal.ts";

export interface CorsOptions {
  /** `*`, a single origin, an allow-list, or a predicate. Default `*`. */
  origin?: string | string[] | ((origin: string, c: Context<any, any>) => boolean);
  methods?: string[];
  /** Allowed request headers. Defaults to echoing `Access-Control-Request-Headers`. */
  allowHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  /** Preflight cache lifetime in seconds. */
  maxAge?: number;
}

/** CORS middleware. Answers preflight requests with 204 and decorates actual responses. */
export function cors(opts: CorsOptions = {}): Middleware {
  const origin = opts.origin ?? "*";
  const methods = (opts.methods ?? ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"]).join(",");
  const credentials = opts.credentials ?? false;
  const wildcard = origin === "*" && !credentials;

  const allowed = (o: string, c: Context<any, any>): boolean => {
    if (typeof origin === "function") return origin(o, c);
    if (Array.isArray(origin)) return origin.includes(o);
    return origin === "*" || origin === o;
  };

  // The Access-Control-Allow-Origin value, or null when the origin is not allowed.
  const resolve = (c: Context<any, any>): string | null => {
    if (wildcard) return "*";
    const o = c.req.headers.get("origin");
    return o && allowed(o, c) ? o : null;
  };

  const apply = (h: Headers, allow: string | null) => {
    if (!wildcard) appendToken(h, "vary", "Origin");
    if (!allow) return;
    h.set("access-control-allow-origin", allow);
    if (credentials) h.set("access-control-allow-credentials", "true");
  };

  return async (c, next) => {
    const allow = resolve(c);
    if (c.method === "OPTIONS" && c.req.headers.has("access-control-request-method")) {
      const h = new Headers();
      apply(h, allow);
      if (allow) {
        h.set("access-control-allow-methods", methods);
        if (opts.allowHeaders?.length) h.set("access-control-allow-headers", opts.allowHeaders.join(","));
        else {
          const requested = c.req.headers.get("access-control-request-headers");
          if (requested) h.set("access-control-allow-headers", requested);
          appendToken(h, "vary", "Access-Control-Request-Headers");
        }
        if (opts.maxAge !== undefined) h.set("access-control-max-age", String(opts.maxAge));
      }
      return new Response(null, { status: 204, headers: h });
    }
    await next();
    const h = resHeaders(c);
    apply(h, allow);
    if (allow && opts.exposeHeaders?.length) h.set("access-control-expose-headers", opts.exposeHeaders.join(","));
  };
}
