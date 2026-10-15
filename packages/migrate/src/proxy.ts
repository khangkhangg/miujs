// The strangler proxy: routes the MiuJS app defines are served by MiuJS; every other request is
// forwarded to the old app, so a team can port one route at a time behind one hostname.
//
// WebSocket upgrades are not proxied (fetch cannot carry them): route WebSocket paths to the old
// app at the load balancer, or port them to MiuJS (`ctx.upgrade`).

import { definePlugin, detectRuntime, isMiuError, type Context } from "miujs";
import { migrateError } from "./errors.ts";

export interface MigrateProxyOptions {
  /** Base URL of the old app, e.g. "http://old-app:8000" (a path such as "/legacy" is kept as a prefix). */
  upstream: string;
  /**
   * Whether this request is served by MiuJS. Called only for requests that match a MiuJS route;
   * return false to send a defined route to the old app anyway (feature flags, canaries).
   * Default: every matched route is ported, except routes tagged "not-ported" (fromOpenApi stubs).
   */
  ported?: (ctx: Context) => boolean;
  /** Milliseconds to wait for the old app's response headers. Default 30 000. */
  timeout?: number;
  /**
   * Keep the client's X-Forwarded-For/-Proto/-Host and Forwarded headers (append to the chain).
   * Only when MiuJS itself sits behind a load balancer that sets them. Default false: they are
   * dropped and rebuilt, so clients cannot spoof their IP to the old app.
   */
  trustForwardedHeaders?: boolean;
  /** Send the public Host header instead of the upstream's. Default false. */
  preserveHost?: boolean;
  /**
   * Set-Cookie `Domain=` naming the upstream host is removed (host-only cookie) by default; set
   * this to write a domain instead, e.g. "example.com" to share with subdomains.
   */
  cookieDomain?: string;
  /** Public origin for rewriting Location headers. Default: the request's origin. */
  publicOrigin?: string;
  /** Extra headers sent to the old app (e.g. a shared secret it checks). Never shown by inspect(). */
  headers?: Record<string, string>;
  /** @internal Override fetch (tests, custom transports). */
  fetch?: (req: Request) => Promise<Response>;
}

// RFC 9110 §7.6.1 connection-specific fields, plus the legacy ones proxies always drop.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const FORWARDED = new Set(["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip", "forwarded"]);

/** Routes tagged with this (fromOpenApi stubs) still go to the old app unless `ported` says otherwise. */
export const NOT_PORTED_TAG = "not-ported";

/** Marks a request as handled by the proxy (read by captureMiddleware). */
export const PROXIED = "migrate.proxied";

function connectionTokens(h: Headers): Set<string> {
  return new Set(
    (h.get("connection") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseUpstream(upstream: string): URL {
  let url: URL | null = null;
  try {
    url = new URL(upstream);
  } catch {}
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw migrateError("CONFIG", 500, `migrateProxy upstream "${String(upstream).slice(0, 80)}" is not an http(s) URL`, 'Pass the old app\'s base URL, e.g. migrateProxy({ upstream: "http://old-app:8000" }).');
  }
  if (url.username || url.password) {
    throw migrateError("CONFIG", 500, "migrateProxy upstream must not contain credentials", "Remove user:pass from the URL; pass migrateProxy({ headers: { authorization: ... } }) instead.");
  }
  return url;
}

function rewriteCookie(cookie: string, upstreamHost: string, domain: string | undefined): string {
  const parts = cookie.split(";");
  const out: string[] = [parts[0]];
  for (const p of parts.slice(1)) {
    const m = /^\s*domain\s*=\s*\.?(.*?)\s*$/i.exec(p);
    if (m && m[1].toLowerCase() === upstreamHost) {
      if (domain) out.push(` Domain=${domain}`);
      continue;
    }
    out.push(p);
  }
  return out.join(";");
}

/** Forwards unmatched requests to the old app. Put it first in `plugins`. */
export function migrateProxy(opts: MigrateProxyOptions) {
  const base = parseUpstream(opts.upstream);
  const prefix = base.pathname.replace(/\/+$/, "");
  const timeout = opts.timeout ?? 30_000;
  const trust = opts.trustForwardedHeaders ?? false;
  // fetch(url, init), not fetch(new Request(...)): a Request would drop Bun's `decompress` option.
  const doFetch = opts.fetch ? (u: URL, i: RequestInit) => opts.fetch!(new Request(u, i)) : (u: URL, i: RequestInit) => fetch(u, i);
  const isBun = detectRuntime() === "bun";

  async function forward(ctx: Context): Promise<Response> {
    const req = ctx.req;
    const url = ctx.url;
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      throw migrateError(
        "WEBSOCKET",
        501,
        `WebSocket upgrade on ${ctx.path} is not proxied to the old app`,
        "Route this WebSocket path straight to the old app at your load balancer, or port it to MiuJS with a route that calls ctx.upgrade().",
      );
    }

    // Build the target from parts: assigning pathname can never change the host (no "//evil" SSRF).
    const target = new URL(base.origin);
    target.pathname = prefix + url.pathname;
    target.search = url.search;

    const drop = connectionTokens(req.headers);
    const headers = new Headers();
    for (const [k, v] of req.headers) {
      if (HOP_BY_HOP.has(k) || drop.has(k) || k === "host") continue;
      if (!trust && FORWARDED.has(k)) continue;
      headers.append(k, v);
    }
    const ip = ctx.ip;
    const priorFor = trust ? req.headers.get("x-forwarded-for") : null;
    const xff = [priorFor, ip].filter(Boolean).join(", ");
    if (xff) headers.set("x-forwarded-for", xff);
    headers.set("x-forwarded-proto", (trust && req.headers.get("x-forwarded-proto")) || url.protocol.slice(0, -1));
    headers.set("x-forwarded-host", (trust && req.headers.get("x-forwarded-host")) || url.host);
    if (opts.preserveHost) headers.set("host", url.host);
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeout);
    const onClientAbort = () => ac.abort();
    req.signal?.addEventListener?.("abort", onClientAbort);

    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
    const init: RequestInit & { duplex?: string; decompress?: boolean } = {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      signal: ac.signal,
    };
    if (hasBody) init.duplex = "half";
    // Bun decodes gzip but keeps Content-Encoding; pass the bytes through untouched instead.
    if (isBun) init.decompress = false;

    let res: Response;
    try {
      res = await doFetch(target, init);
    } catch (err) {
      if (isMiuError(err)) throw err;
      if (timedOut) {
        throw migrateError(
          "UPSTREAM_TIMEOUT",
          504,
          `The old app at ${base.origin} did not answer ${req.method} ${ctx.path} within ${timeout} ms`,
          "Check the old app's health and logs, or raise migrateProxy({ timeout }).",
        );
      }
      throw migrateError(
        "UPSTREAM",
        502,
        `Could not reach the old app at ${base.origin} for ${req.method} ${ctx.path}`,
        `Start the old app, or point migrateProxy({ upstream }) at where it runs (now ${base.origin}). This request matched no MiuJS route, so it was forwarded.`,
        { upstream: base.origin },
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener?.("abort", onClientAbort);
    }

    const resDrop = connectionTokens(res.headers);
    const out = new Headers();
    for (const [k, v] of res.headers) {
      if (HOP_BY_HOP.has(k) || resDrop.has(k) || k === "set-cookie") continue;
      out.append(k, v);
    }
    for (const c of res.headers.getSetCookie()) out.append("set-cookie", rewriteCookie(c, base.hostname.toLowerCase(), opts.cookieDomain));
    if (!isBun) {
      // Other runtimes hand us a decoded body: its encoding and length headers no longer apply.
      out.delete("content-encoding");
      out.delete("content-length");
    }
    const loc = res.headers.get("location");
    if (loc) {
      let abs: URL | null = null;
      try {
        abs = new URL(loc);
      } catch {}
      if (abs && abs.origin === base.origin) {
        let path = abs.pathname;
        if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length) || "/";
        out.set("location", (opts.publicOrigin ?? url.origin).replace(/\/+$/, "") + path + abs.search + abs.hash);
      }
    }
    const noBody = req.method === "HEAD" || res.status === 204 || res.status === 304;
    // Release the upstream connection when its (empty) body is not passed on.
    if (noBody) res.body?.cancel().catch(() => {});
    return new Response(noBody ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
  }

  return definePlugin({
    name: "migrate-proxy",
    onRequest(ctx) {
      if (ctx.route && (opts.ported?.(ctx) ?? !ctx.route.tags.includes(NOT_PORTED_TAG))) return;
      ctx.state[PROXIED] = true;
      return forward(ctx);
    },
    inspect() {
      return {
        upstream: base.origin + prefix,
        timeout,
        trustForwardedHeaders: trust,
        preserveHost: !!opts.preserveHost,
        cookieDomain: opts.cookieDomain ?? null,
        portedFilter: !!opts.ported,
        extraHeaders: Object.keys(opts.headers ?? {}),
        websockets: "not proxied",
      };
    },
  });
}
