import type { Middleware } from "../core/app.ts";
import { resHeaders } from "./internal.ts";

/** Each value overrides the default header; `false` disables it. */
export interface SecureHeadersOptions {
  xContentTypeOptions?: string | false;
  xFrameOptions?: string | false;
  referrerPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  /** Sent only on https requests. */
  strictTransportSecurity?: string | false;
  /** Off unless given. */
  contentSecurityPolicy?: string | false;
}

/** Adds common security headers without overwriting ones the handler set. */
export function secureHeaders(opts: SecureHeadersOptions = {}): Middleware {
  const pick = (v: string | false | undefined, d: string | false) => (v === undefined ? d : v);
  const always: [string, string | false][] = [
    ["x-content-type-options", pick(opts.xContentTypeOptions, "nosniff")],
    ["x-frame-options", pick(opts.xFrameOptions, "SAMEORIGIN")],
    ["referrer-policy", pick(opts.referrerPolicy, "strict-origin-when-cross-origin")],
    ["cross-origin-opener-policy", pick(opts.crossOriginOpenerPolicy, "same-origin")],
    ["content-security-policy", pick(opts.contentSecurityPolicy, false)],
  ];
  const hsts = pick(opts.strictTransportSecurity, "max-age=15552000; includeSubDomains");

  return async (c, next) => {
    await next();
    const h = resHeaders(c);
    for (const [k, v] of always) if (v && !h.has(k)) h.set(k, v);
    const https = c.url.protocol === "https:" || c.req.headers.get("x-forwarded-proto") === "https";
    if (hsts && https && !h.has("strict-transport-security")) h.set("strict-transport-security", hsts);
  };
}
