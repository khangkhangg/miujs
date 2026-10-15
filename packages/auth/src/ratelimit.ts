// Fixed-window rate limiting for sign-in endpoints.

import { errors, type Env } from "miujs";

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (only meaningful when `ok` is false). */
  retryAfter: number;
}

export interface RateLimiter {
  readonly kind: string;
  /** Cloudflare Rate Limiting binding name, when this limiter uses one (for `miu deploy cloudflare`). */
  readonly binding?: string;
  /** Count one hit for `key` and report whether it is within `limit` per `windowSeconds`. */
  hit(key: string, limit: number, windowSeconds: number, env?: Env): Promise<RateLimitResult>;
}

/**
 * In-process counters. The default; exact on a single Bun/Deno/Node server. On Workers each isolate
 * counts separately, so limits are approximate there: use `cloudflareRateLimiter` or Turnstile too.
 */
export function memoryRateLimiter(opts: { now?: () => number; maxKeys?: number } = {}): RateLimiter & { readonly size: number } {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 50_000;
  const windows = new Map<string, { count: number; resetAt: number; limit: number }>();
  let sweepAt = Math.min(maxKeys, 1024);

  // Expired windows are swept whenever the map has doubled since the last sweep (O(1) per new key,
  // amortized). At `maxKeys`, the oldest windows that are not over their limit go first, in a
  // batch: a flood of fresh emails or IPs cannot reset a counter that is currently blocking.
  const makeRoom = (t: number) => {
    for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
    if (windows.size >= maxKeys) {
      const target = maxKeys - Math.max(1, maxKeys >> 4);
      for (const [k, v] of windows) {
        if (windows.size <= target) break;
        if (v.count < v.limit) windows.delete(k);
      }
      for (const k of windows.keys()) {
        if (windows.size <= target) break;
        windows.delete(k);
      }
    }
    sweepAt = Math.min(maxKeys, Math.max(1024, windows.size * 2));
  };

  return {
    kind: "memory",
    get size() {
      return windows.size;
    },
    async hit(key, limit, windowSeconds) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        if (w) windows.delete(key);
        else if (windows.size >= sweepAt) makeRoom(t);
        w = { count: 0, resetAt: t + windowSeconds * 1000, limit };
        windows.set(key, w);
      }
      w.count++;
      w.limit = limit;
      return { ok: w.count <= limit, retryAfter: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
    },
  };
}

interface CfRateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Cloudflare's Rate Limiting binding (`[[ratelimits]]` in wrangler.toml), shared across isolates.
 * The binding's own `limit`/`period` apply to every rule; MiuJS's per-rule numbers are ignored, so
 * configure the binding for your login limit (e.g. 10 per 60 s).
 */
export function cloudflareRateLimiter(binding: string): RateLimiter {
  return {
    kind: `cloudflare:${binding}`,
    binding,
    async hit(key, _limit, windowSeconds, env) {
      const b = env?.[binding] as CfRateLimitBinding | undefined;
      if (!b || typeof b.limit !== "function") {
        // Fail closed-to-the-developer: a silently missing limiter would leave login unprotected.
        throw errors.config(
          "MIU_E_AUTH_RATELIMIT_BINDING",
          `Rate limit binding "${binding}" is not configured`,
          `Add a [[ratelimits]] binding named ${binding} to wrangler.toml, or use memoryRateLimiter().`,
        );
      }
      const { success } = await b.limit({ key });
      return { ok: success, retryAfter: windowSeconds };
    },
  };
}

export interface RateLimitOptions {
  limiter?: RateLimiter;
  /**
   * Header holding the client IP, set by a proxy you trust in front of the app, e.g.
   * `"cf-connecting-ip"` (Cloudflare in front of a Bun server) or `"x-real-ip"` (nginx). Without it
   * MiuJS uses `ctx.ip` (Workers and Bun know the real address). Never set this to a header clients
   * can send directly, or attackers pick their own IP. With a list (X-Forwarded-For), the rightmost
   * entry is used: the one your proxy appended.
   *
   * @deprecated Prefer core's `miu({ trustProxy })`, which sets `ctx.ip`; auth then needs no option.
   */
  trustProxyHeader?: string;
  login?: { perIpAccount?: number; perAccount?: number; perIp?: number; windowSeconds?: number };
  register?: { perIp?: number; windowSeconds?: number };
  /** POST /password/forgot. Counts unknown emails too, so a 429 reveals nothing. */
  passwordReset?: { perIp?: number; perAccount?: number; windowSeconds?: number };
  /** POST /verify-email/request. */
  verifyEmail?: { perIp?: number; perAccount?: number; windowSeconds?: number };
}

export const RATE_LIMIT_DEFAULTS = {
  login: { perIpAccount: 10, perAccount: 50, perIp: 100, windowSeconds: 15 * 60 },
  register: { perIp: 10, windowSeconds: 60 * 60 },
  passwordReset: { perIp: 20, perAccount: 5, windowSeconds: 60 * 60 },
  verifyEmail: { perIp: 20, perAccount: 5, windowSeconds: 60 * 60 },
};
