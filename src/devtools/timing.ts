import type { Middleware } from "../core/app.ts";
import type { Context } from "../core/context.ts";
import { resHeaders } from "../batteries/internal.ts";
import { isDev } from "./env.ts";

export interface TimingEntry {
  name: string;
  /** Milliseconds, rounded to 0.1ms. Absent for marker-only metrics (e.g. `cache-hit`). */
  dur?: number;
  desc?: string;
}

/** Request-scoped timer, available as `c.get("timing")` (or `getTiming(c)`). */
export interface Timing {
  /** False when Server-Timing is off; all methods still work (and cost almost nothing). */
  readonly enabled: boolean;
  readonly entries: readonly TimingEntry[];
  /** Start a named timer. End it with `end(name)`; unfinished timers are closed when the response is sent. */
  start(name: string, desc?: string): void;
  /** Stop a timer started with `start()`; returns its duration in ms. */
  end(name: string): number | undefined;
  /** Time a sync or async function. Recorded even when it throws. */
  measure<T>(name: string, fn: () => T | Promise<T>, desc?: string): Promise<T>;
  /** Record a metric you measured yourself, or a marker without a duration. */
  add(name: string, dur?: number, desc?: string): void;
}

export interface TimingOptions {
  /**
   * Send `Server-Timing`. Default: on in development, **off in production** — it reveals how long
   * internal work (DB, auth, upstreams) takes. Set `true` to opt in everywhere.
   */
  enabled?: boolean;
  /** Add the automatic `total` metric (middleware start → response). Default true. */
  total?: boolean;
  /**
   * `Timing-Allow-Origin` value, so cross-origin pages can read the timings via the Resource Timing API
   * (DevTools shows them regardless). e.g. `"*"` or `"https://app.example"`.
   */
  allowOrigin?: string;
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const now = () => performance.now();

/** Metric names are header tokens (RFC 9110 `tchar`); anything else becomes `_`. */
export function sanitizeMetricName(name: string): string {
  return String(name).replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g, "_") || "metric";
}

/** `desc` is a quoted-string; non-printable/non-ASCII characters become `?` so the header stays valid. */
function quote(desc: string): string {
  return `"${String(desc).replace(/[^\t\x20-\x7e]/g, "?").replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export function formatServerTiming(entries: readonly TimingEntry[]): string {
  return entries
    .map((e) => {
      let s = sanitizeMetricName(e.name);
      if (e.desc) s += `;desc=${quote(e.desc)}`;
      if (e.dur !== undefined) s += `;dur=${e.dur}`;
      return s;
    })
    .join(", ");
}

class ServerTiming implements Timing {
  readonly enabled = true;
  readonly entries: TimingEntry[] = [];
  private open = new Map<string, { at: number; desc?: string }>();

  start(name: string, desc?: string): void {
    this.open.set(name, { at: now(), desc });
  }

  end(name: string): number | undefined {
    const o = this.open.get(name);
    if (!o) return undefined;
    this.open.delete(name);
    const dur = now() - o.at;
    this.add(name, dur, o.desc);
    return dur;
  }

  async measure<T>(name: string, fn: () => T | Promise<T>, desc?: string): Promise<T> {
    const at = now();
    try {
      return await fn();
    } finally {
      this.add(name, now() - at, desc);
    }
  }

  add(name: string, dur?: number, desc?: string): void {
    const e: TimingEntry = { name };
    if (dur !== undefined && Number.isFinite(dur)) e.dur = round(Math.max(0, dur));
    if (desc) e.desc = desc;
    this.entries.push(e);
  }

  /** Close timers that were started but never ended. */
  finish(): void {
    for (const name of [...this.open.keys()]) this.end(name);
  }
}

const NOOP: Timing = Object.freeze({
  enabled: false,
  entries: Object.freeze([]) as readonly TimingEntry[],
  start() {},
  end() {
    return undefined;
  },
  async measure<T>(_name: string, fn: () => T | Promise<T>) {
    return await fn();
  },
  add() {},
});

/** The request's timer, or a no-op one when `timing()` is not installed or is disabled. */
export function getTiming(c: Context<any, any>): Timing {
  return (c.get("timing") as Timing | undefined) ?? NOOP;
}

/**
 * `Server-Timing` middleware: shows up in DevTools → Network → (request) → Timing.
 * Register it first so `total` covers the whole pipeline.
 *
 * ```ts
 * app.use(timing());
 * app.get("/tours", async (c) => {
 *   const t = c.get("timing");
 *   const rows = await t.measure("db", () => db.all("select * from tours"), "Load tours");
 *   return rows;
 * });
 * ```
 */
export function timing(opts: TimingOptions = {}): Middleware {
  const total = opts.total ?? true;
  return async (c, next) => {
    if (!(opts.enabled ?? isDev(c.env as Record<string, unknown>))) {
      c.set("timing", NOOP);
      return next();
    }
    const t = new ServerTiming();
    c.set("timing", t);
    const start = now();
    await next();
    if (!c.res) return;
    t.finish();
    if (total) t.add("total", now() - start);
    const h = resHeaders(c);
    if (t.entries.length) h.append("server-timing", formatServerTiming(t.entries));
    if (opts.allowOrigin) h.set("timing-allow-origin", opts.allowOrigin);
  };
}
