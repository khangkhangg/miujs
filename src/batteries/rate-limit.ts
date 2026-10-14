import type { Context } from "../core/context.ts";
import type { Middleware } from "../core/app.ts";
import { problem } from "../core/errors.ts";
import type { Store } from "./store/index.ts";
import { resHeaders } from "./internal.ts";

export interface RateLimitOptions {
  store: Store;
  /** Max requests per window. */
  limit: number;
  /** Window length in seconds. */
  window: number;
  /** Bucket key; defaults to the client IP. */
  key?: (c: Context<any, any>) => string | Promise<string>;
  prefix?: string;
  skip?: (c: Context<any, any>) => boolean | Promise<boolean>;
}

/** Best-effort client IP from proxy headers. Only trust these behind a proxy that sets them. */
export function clientIp(c: Context<any, any>): string {
  const h = c.req.headers;
  const ip = h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip");
  return ip || "anonymous";
}

/** Fixed-window rate limiter with IETF `RateLimit-*` headers and a 429 problem+json response. */
export function rateLimit(opts: RateLimitOptions): Middleware {
  const { store, limit, window } = opts;
  const prefix = opts.prefix ?? "rl:";
  const keyOf = opts.key ?? clientIp;
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
