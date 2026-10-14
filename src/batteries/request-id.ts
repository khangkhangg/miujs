import type { Middleware } from "../core/app.ts";
import { resHeaders } from "./internal.ts";

export interface RequestIdOptions {
  header?: string;
  generate?: () => string;
}

const VALID = /^[\w\-.:]{1,128}$/;

/** Reuses a well-formed incoming request id or generates one; exposed as `c.get("requestId")` and echoed in the response. */
export function requestId(opts: RequestIdOptions = {}): Middleware {
  const header = opts.header ?? "x-request-id";
  const generate = opts.generate ?? (() => crypto.randomUUID());
  return async (c, next) => {
    const incoming = c.req.headers.get(header);
    const id = incoming && VALID.test(incoming) ? incoming : generate();
    c.set("requestId", id);
    await next();
    resHeaders(c).set(header, id);
  };
}
