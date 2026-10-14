import type { Middleware } from "../core/app.ts";
import type { AppLike, Context } from "../core/context.ts";
import { Router } from "../core/router.ts";

/**
 * Strangler-fig migration: put Miu in front of a legacy PHP/Python app and
 * forward everything Miu does not handle yet. Port one route at a time.
 *
 * - `legacyProxy()` (recommended): middleware. Forwards when no Miu route matches
 *   the path *and* method, so a half-ported resource (GET in Miu, POST still in
 *   PHP) works. Register it after middleware that answers requests itself
 *   (`openapi()`, `mcp()`, static files), since those paths have no routes.
 * - `legacyFallback()`: a handler for `app.notFound(...)`. Only unknown paths are
 *   forwarded; a known path with another method still gets Miu's 405.
 */

export interface LegacyProxyOptions {
  /** Legacy origin, e.g. `http://127.0.0.1:8080` or `http://php-fpm-nginx/app/` (base path is prepended). */
  target: string | URL;
  /** Map the incoming path before forwarding (query string is kept). */
  rewrite?: (path: string) => string;
  /** Send the original Host header instead of the target's (for name-based virtual hosts). Default false. */
  forwardHost?: boolean;
  /** Abort after this many milliseconds and answer 504. */
  timeout?: number;
  /**
   * Client IP to append to `x-forwarded-for`. Web-standard requests do not carry the
   * socket address; on Bun pass e.g. `(c) => server.requestIP(c.req)?.address`.
   * Default: `cf-connecting-ip` / `x-real-ip` when present.
   */
  clientIp?: (c: Context<any, any>) => string | undefined | null;
  /** Custom fetch (e.g. a Cloudflare service binding's `fetch`). */
  fetch?: (req: Request) => Promise<Response>;
}

/** Middleware that forwards requests with no matching Miu route to the legacy app. */
export function legacyProxy(opts: LegacyProxyOptions): Middleware {
  const forward = createForwarder(opts);
  let cache: { app: AppLike; count: number; router: Router<true> } | undefined;
  const routerFor = (app: AppLike) => {
    if (!cache || cache.app !== app || cache.count !== app.routes.length) {
      const router = new Router<true>();
      for (const r of app.routes) router.add(r.method, r.path, true);
      cache = { app, count: app.routes.length, router };
    }
    return cache.router;
  };
  return async (c, next) => {
    if (routerFor(c.app).find(c.method, c.url.pathname)) return next();
    return forward(c);
  };
}

/** `app.notFound(legacyFallback({ target }))`: forward unknown paths to the legacy app. */
export function legacyFallback(opts: LegacyProxyOptions): (c: Context<any, any>) => Promise<Response> {
  return createForwarder(opts);
}

// RFC 9110 §7.6.1 hop-by-hop headers, plus host (set by fetch) and content-length (recomputed).
const HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function stripHop(h: Headers): void {
  for (const name of (h.get("connection") ?? "").split(",")) if (name.trim()) h.delete(name.trim());
  for (const name of HOP) h.delete(name);
}

function createForwarder(opts: LegacyProxyOptions): (c: Context<any, any>) => Promise<Response> {
  const target = new URL(opts.target);
  const base = target.pathname.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((req: Request) => fetch(req));

  return async (c) => {
    const incoming = c.url;
    const path = opts.rewrite ? opts.rewrite(incoming.pathname) : incoming.pathname;
    const url = new URL(base + path + incoming.search, target.origin);

    const headers = new Headers(c.req.headers);
    stripHop(headers);
    headers.delete("host");
    headers.delete("content-length");
    if (opts.forwardHost) headers.set("host", incoming.host);
    const ip = opts.clientIp ? opts.clientIp(c) : (c.req.headers.get("cf-connecting-ip") ?? c.req.headers.get("x-real-ip"));
    if (ip) {
      const prev = headers.get("x-forwarded-for");
      headers.set("x-forwarded-for", prev ? `${prev}, ${ip}` : ip);
    }
    if (!headers.has("x-forwarded-proto")) headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
    if (!headers.has("x-forwarded-host")) headers.set("x-forwarded-host", incoming.host);

    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.body !== null;
    const init: RequestInit & { duplex?: "half" } = {
      method: c.req.method,
      headers,
      redirect: "manual",
      body: hasBody ? c.req.body : undefined,
      signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
    };
    if (hasBody) init.duplex = "half";

    let res: Response;
    try {
      res = await doFetch(new Request(url, init));
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return new Response(timedOut ? "Legacy upstream timed out" : "Legacy upstream unreachable", {
        status: timedOut ? 504 : 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const out = new Headers();
    res.headers.forEach((v, k) => {
      if (k !== "set-cookie") out.set(k, v);
    });
    for (const cookie of res.headers.getSetCookie()) out.append("set-cookie", cookie);
    stripHop(out);
    // fetch() already decoded the body, so the original encoding/length no longer apply.
    out.delete("content-encoding");
    out.delete("content-length");
    const loc = out.get("location");
    if (loc) {
      try {
        const l = new URL(loc, url);
        if (/^https?:\/\//i.test(loc) && l.origin === target.origin) {
          const p = base && l.pathname.startsWith(base + "/") ? l.pathname.slice(base.length) : l.pathname;
          out.set("location", incoming.origin + p + l.search + l.hash);
        }
      } catch {
        // leave malformed Location headers untouched
      }
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  };
}
