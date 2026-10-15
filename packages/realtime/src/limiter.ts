// Small in-memory rate limiters (no timers; callers pass the current time).

/** Classic token bucket: `burst` tokens, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly perMs: number;
  private readonly burst: number;

  constructor(perSecond: number, burst: number, now: number) {
    this.perMs = perSecond / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  /** Takes one token if available. */
  take(now: number): boolean {
    if (now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.perMs);
      this.last = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** True when the bucket is full again (nothing to remember). */
  full(now: number): boolean {
    return this.tokens + Math.max(0, now - this.last) * this.perMs >= this.burst;
  }
}

/** One token bucket per key (e.g. per IP). Full buckets are forgotten to bound memory. */
export class KeyedLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly maxKeys: number;

  constructor(opts: { perSecond: number; burst: number; maxKeys?: number }) {
    this.perSecond = opts.perSecond;
    this.burst = opts.burst;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  take(key: string, now: number): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      b = new TokenBucket(this.perSecond, this.burst, now);
      this.buckets.set(key, b);
    }
    return b.take(now);
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (b.full(now)) this.buckets.delete(k);
    // Still full of active abusers: drop the oldest entries rather than grow without bound.
    for (const k of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) break;
      this.buckets.delete(k);
    }
  }
}
