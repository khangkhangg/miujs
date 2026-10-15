import type { Context } from "../core/context.ts";
import type { Middleware } from "../core/app.ts";
import { problem } from "../core/errors.ts";
import type { Store } from "./store/types.ts";
import { resHeaders } from "./internal.ts";

export interface RateLimitOptions {
  store: Store;
  /** Max requests per window. */
  limit: number;
  /** Window length in seconds. */
  window: number;
  /** Bucket key; defaults to the client IP (see `trustProxy`). */
  key?: (c: Context<any, any>) => string | Promise<string>;
  /**
   * Which forwarding headers to believe for the default key. Default `false`: only the socket address
   * (`c.ip`) — headers are client-controlled and would let anyone reset their bucket. `true`: the first
   * `X-Forwarded-For` / `X-Real-IP` hop (only behind a proxy that overwrites them). `"cloudflare"`:
   * `CF-Connecting-IP` (set by Cloudflare; use on Workers or behind Cloudflare).
   */
  trustProxy?: TrustProxy;
  prefix?: string;
  skip?: (c: Context<any, any>) => boolean | Promise<boolean>;
}

export type TrustProxy = boolean | "cloudflare";

/**
 * The client IP for rate limiting and logs. By default only the socket address (`c.ip`); forwarding
 * headers are honoured only when `trustProxy` says a proxy you control sets them. Requests with no known
 * address (in-process, Workers without `trustProxy: "cloudflare"`) share the "unknown" bucket — failing
 * closed rather than letting a header pick the bucket.
 */
export function clientIp(c: Context<any, any>, trustProxy: TrustProxy = false): string {
  const h = c.req.headers;
  if (trustProxy === "cloudflare") return h.get("cf-connecting-ip") || c.ip || "unknown";
  if (trustProxy) return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || c.ip || "unknown";
  return c.ip || "unknown";
}

/** Fixed-window rate limiter with IETF `RateLimit-*` headers and a 429 problem+json response. */
export function rateLimit(opts: RateLimitOptions): Middleware {
  const { store, limit, window } = opts;
  const prefix = opts.prefix ?? "rl:";
  const keyOf = opts.key ?? ((c: Context<any, any>) => clientIp(c, opts.trustProxy));
  return async (c, next) => {
    if (opts.skip && (await opts.skip(c))) return next();
    const key = prefix + (await keyOf(c));
    const count = await store.incr(key, 1, { ttl: window });
    const ttl = await store.ttl(key);
    const reset = ttl === undefined || ttl < 0 ? window : ttl;
    const headers = {
      "ratelimit-limit": String(limit),
      "ratelimit-remaining": String(Math.max(0, limit - count)),
      "ratelimit-reset": String(reset),
    };
    if (count > limit) {
      return problem(
        429,
        {
          code: "rate_limited",
          detail: `Rate limit of ${limit} requests per ${window}s exceeded. Retry after ${reset}s.`,
        },
        { ...headers, "retry-after": String(reset) },
      );
    }
    await next();
    const h = resHeaders(c);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
  };
}
