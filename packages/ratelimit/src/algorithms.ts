// Rate limiting algorithms as pure functions over a small JSON state, so every store (memory, KV,
// Durable Object, ...) runs exactly the same logic.

import { errors } from "miujs";

export type Algorithm = "fixed" | "sliding" | "token-bucket";

/** `30` (seconds) or `"250ms"`, `"10s"`, `"15m"`, `"1h"`, `"1d"`. */
export type WindowSpec = number | string;

export interface Policy {
  algorithm: Algorithm;
  /** Requests per window (token bucket: refill of `limit` tokens per window). */
  limit: number;
  windowMs: number;
  /** Units this hit consumes. Default 1. */
  cost: number;
  /** Token bucket capacity. Default `limit`. */
  burst?: number;
}

export interface Decision {
  allowed: boolean;
  limit: number;
  /** Units left after this hit; null when the backend cannot tell (Cloudflare binding). */
  remaining: number | null;
  /** Ms until the window resets (token bucket: until the bucket is full). */
  resetMs: number;
  /** Ms to wait before retrying; 0 when allowed. */
  retryAfterMs: number;
}

export interface StepResult {
  state: State;
  decision: Decision;
  /** After this long without hits the state is equivalent to no state and can be dropped. */
  ttlMs: number;
}

type FixedState = { a: "f"; s: number; c: number };
type SlidingState = { a: "s"; s: number; c: number; p: number };
type BucketState = { a: "t"; t: number; u: number };
export type State = FixedState | SlidingState | BucketState;

export const configError = (message: string, fix: string, details?: unknown) => errors.config("MIU_E_RATELIMIT_CONFIG", message, fix, details);

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Window length in milliseconds. */
export function parseWindow(w: WindowSpec): number {
  let ms = Number.NaN;
  if (typeof w === "number") ms = w * 1000;
  else if (typeof w === "string") {
    const m = /^(\d+)(ms|s|m|h|d)$/.exec(w.trim());
    if (m) ms = Number(m[1]) * UNITS[m[2]];
  }
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isInteger(ms)) {
    throw configError(`Invalid rate limit window ${JSON.stringify(w)}`, 'Use a positive number of seconds or a string like "10s", "1m", "15m", "1h" or "1d".');
  }
  return ms;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const EPS = 1e-9;

/** Validates stored state; anything odd is treated as no state, never trusted. */
function read(state: unknown, p: Policy, now: number): State | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  if (p.algorithm === "fixed" && s.a === "f" && num(s.s) && num(s.c) && s.c >= 0 && s.c <= p.limit) return s as FixedState;
  if (p.algorithm === "sliding" && s.a === "s" && num(s.s) && num(s.c) && num(s.p) && s.c >= 0 && s.p >= 0 && s.c <= p.limit && s.p <= p.limit) return s as SlidingState;
  if (p.algorithm === "token-bucket" && s.a === "t" && num(s.t) && num(s.u) && s.t >= 0 && s.t <= (p.burst ?? p.limit) + EPS && s.u <= now) return s as BucketState;
  return null;
}

/** Applies one hit of `p.cost` units at time `now`. Denied hits leave the state unchanged. */
export function step(state: unknown, p: Policy, now: number): StepResult {
  const prior = read(state, p, now);
  if (p.algorithm === "token-bucket") return bucket(prior as BucketState | null, p, now);
  const ws = Math.floor(now / p.windowMs) * p.windowMs;
  const end = ws + p.windowMs;
  if (p.algorithm === "fixed") {
    const f = prior as FixedState | null;
    const count = f && f.s === ws ? f.c : 0;
    const allowed = count + p.cost <= p.limit;
    const c = allowed ? count + p.cost : count;
    return {
      state: { a: "f", s: ws, c },
      decision: { allowed, limit: p.limit, remaining: p.limit - c, resetMs: end - now, retryAfterMs: allowed ? 0 : end - now },
      ttlMs: end - now,
    };
  }
  const sl = prior as SlidingState | null;
  let curr = 0;
  let prev = 0;
  if (sl && sl.s === ws) {
    curr = sl.c;
    prev = sl.p;
  } else if (sl && sl.s === ws - p.windowMs) prev = sl.c;
  const elapsed = now - ws;
  const weighted = (prev * (p.windowMs - elapsed)) / p.windowMs;
  const allowed = weighted + curr + p.cost <= p.limit + EPS;
  if (allowed) curr += p.cost;
  let retryAfterMs = 0;
  if (!allowed) {
    const room = p.limit - curr - p.cost;
    if (room >= 0 && prev > 0) retryAfterMs = Math.ceil(ws + p.windowMs * (1 - room / prev) - now);
    else retryAfterMs = end - now + (curr > 0 ? Math.max(0, Math.ceil(p.windowMs * (1 - (p.limit - p.cost) / curr))) : 0);
    retryAfterMs = Math.max(1, retryAfterMs);
  }
  return {
    state: { a: "s", s: ws, c: curr, p: prev },
    decision: { allowed, limit: p.limit, remaining: Math.max(0, Math.floor(p.limit - weighted - curr + EPS)), resetMs: end - now, retryAfterMs },
    ttlMs: end - now + p.windowMs,
  };
}

function bucket(prior: BucketState | null, p: Policy, now: number): StepResult {
  const cap = p.burst ?? p.limit;
  const rate = p.limit / p.windowMs; // tokens per ms
  const tokens = prior ? Math.min(cap, prior.t + Math.max(0, now - prior.u) * rate) : cap;
  const allowed = tokens + EPS >= p.cost;
  const left = allowed ? Math.max(0, tokens - p.cost) : tokens;
  const full = Math.ceil((cap - left) / rate - EPS);
  const state: BucketState = allowed ? { a: "t", t: left, u: now } : (prior ?? { a: "t", t: cap, u: now });
  return {
    state,
    decision: {
      allowed,
      limit: cap,
      remaining: Math.floor(left + EPS),
      resetMs: Math.max(0, full),
      retryAfterMs: allowed ? 0 : Math.max(1, Math.ceil((p.cost - tokens) / rate - EPS)),
    },
    ttlMs: Math.max(1, full),
  };
}

/** Checks a policy once, at configuration time. */
export function checkPolicy(p: Policy, where: string): Policy {
  if (!Number.isInteger(p.limit) || p.limit < 1) throw configError(`${where}: limit must be a positive integer`, "Set limit to the number of requests allowed per window, e.g. limit: 100.");
  if (!["fixed", "sliding", "token-bucket"].includes(p.algorithm)) {
    throw configError(`${where}: unknown algorithm ${JSON.stringify(p.algorithm)}`, 'Use algorithm: "fixed", "sliding" (default) or "token-bucket".');
  }
  if (p.burst !== undefined && (!Number.isInteger(p.burst) || p.burst < 1)) throw configError(`${where}: burst must be a positive integer`, "Set burst to the bucket capacity, e.g. burst: 20.");
  if (p.burst !== undefined && p.algorithm !== "token-bucket") throw configError(`${where}: burst only applies to the token bucket`, 'Remove burst, or set algorithm: "token-bucket".');
  const cap = p.burst ?? p.limit;
  if (!Number.isInteger(p.cost) || p.cost < 1 || p.cost > cap) throw configError(`${where}: cost must be an integer from 1 to ${cap}`, "A hit can never cost more than the limit (or burst).");
  return p;
}
