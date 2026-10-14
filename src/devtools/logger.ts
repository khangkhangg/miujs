import type { Middleware } from "../core/app.ts";
import { logger } from "../batteries/logger.ts";
import { isDev, readEnv } from "./env.ts";
import { errorInfo, recalledError } from "./shared.ts";
import type { Timing } from "./timing.ts";

export interface DevLoggerOptions {
  /**
   * Line sink. Default: `console.log`, with details in a `console.groupCollapsed` group
   * (collapsible in the DevTools console when attached with `--inspect`).
   */
  write?: (line: string) => void;
  /** ANSI colors (also rendered by the DevTools console). Default: on unless `NO_COLOR` is set. */
  colors?: boolean;
  /** Force the dev format (`true`) or JSON (`false`). Default: dev format when `isDev(c.env)`, JSON otherwise. */
  pretty?: boolean;
}

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m" };

/**
 * Development access log built on `logger()`: in development a colored line per request
 * (`GET /tours/7 200 3.1ms`) followed by its Server-Timing marks and, for failures, the error with a
 * clickable `file:line:col`. In production it is exactly `logger({ format: "json" })`.
 *
 * The error location needs `app.onError(devErrors())`; timing marks need `timing()`.
 */
export function devLogger(opts: DevLoggerOptions = {}): Middleware {
  const json = logger({ format: "json", write: opts.write });
  const colors = opts.colors ?? !readEnv("NO_COLOR");
  const paint = (code: string, s: string) => (colors ? `${code}${s}${C.reset}` : s);

  const emit = (head: string, details: string[]) => {
    if (opts.write) {
      opts.write(head);
      for (const d of details) opts.write(`  ${d}`);
    } else if (details.length && typeof console.groupCollapsed === "function") {
      console.groupCollapsed(head);
      for (const d of details) console.log(d);
      console.groupEnd();
    } else console.log(head);
  };

  return async (c, next) => {
    if (!(opts.pretty ?? isDev(c.env as Record<string, unknown>))) return json(c, next);
    const start = performance.now();
    try {
      await next();
    } finally {
      const ms = Math.round((performance.now() - start) * 10) / 10;
      const status = c.res?.status ?? 500;
      const sc = status >= 500 ? C.red : status >= 400 ? C.yellow : status >= 300 ? C.cyan : C.green;
      const id = c.get("requestId") as string | undefined;
      let head = `${paint(C.bold, c.method)} ${c.url.pathname} ${paint(sc, String(status))} ${paint(ms > 500 ? C.yellow : C.dim, `${ms}ms`)}`;
      if (id) head += ` ${paint(C.dim, id)}`;

      const details: string[] = [];
      const marks = ((c.get("timing") as Timing | undefined)?.entries ?? []).filter((e) => e.name !== "total");
      for (const m of marks) details.push(`${paint(C.magenta, m.name)} ${m.dur !== undefined ? `${m.dur}ms` : ""}${m.desc ? ` ${paint(C.dim, m.desc)}` : ""}`.trimEnd());
      const err = recalledError(c);
      if (err !== undefined) {
        const info = errorInfo(err);
        details.push(paint(C.red, `${info.name}: ${info.message}`));
        if (info.location) details.push(`→ ${info.location}`);
        for (const cause of info.cause) details.push(paint(C.dim, `caused by ${cause.name}: ${cause.message}${cause.location ? ` (${cause.location})` : ""}`));
      }
      emit(head, details);
    }
  };
}
