import type { Middleware } from "../core/app.ts";
import { HttpError } from "../core/errors.ts";

export interface LoggerOptions {
  write?: (line: string) => void;
  /** `json` (default): one JSON object per line. `pretty`: `GET /path 200 1.2ms <requestId>`. */
  format?: "json" | "pretty";
}

/** Writes one access-log line per request. */
export function logger(opts: LoggerOptions = {}): Middleware {
  const write = opts.write ?? console.log;
  const format = opts.format ?? "json";
  return async (c, next) => {
    const start = performance.now();
    let status: number | undefined;
    try {
      await next();
      status = c.res?.status;
    } catch (err) {
      // The app turns this into a response after middleware unwinds; log the status it will most likely get.
      status = err instanceof HttpError ? err.status : 500;
      throw err;
    } finally {
      const duration = Math.round((performance.now() - start) * 10) / 10;
      const id = c.get("requestId") as string | undefined;
      const path = c.url.pathname;
      if (format === "pretty") write(`${c.method} ${path} ${status} ${duration}ms${id ? ` ${id}` : ""}`);
      else write(JSON.stringify({ time: new Date().toISOString(), method: c.method, path, status, duration, requestId: id }));
    }
  };
}
