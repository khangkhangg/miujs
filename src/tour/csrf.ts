import type { Middleware } from "../core/app.ts";
import { problem } from "../core/errors.ts";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for cookie-authenticated JSON/upload APIs. Cookies are the only credential a browser attaches on
 * its own, so a state-changing request passes when it carries no cookie, or carries an `Authorization` header,
 * or is provably not a plain cross-site form post: `Sec-Fetch-Site` (when sent) must be `same-origin`/`none`,
 * and the request must have an `X-Requested-With` header or a JSON content type (both force a CORS preflight
 * cross-origin). Complements `SameSite=Lax` session cookies (which already stop most cross-site POSTs).
 */
export function csrfGuard(): Middleware {
  return (c, next) => {
    if (SAFE.has(c.method)) return next();
    const h = c.req.headers;
    if (h.has("authorization") || !h.has("cookie")) return next();
    const site = h.get("sec-fetch-site");
    const sameOrigin = !site || site === "same-origin" || site === "none";
    const type = (h.get("content-type") ?? "").toLowerCase();
    const nonSimple = h.has("x-requested-with") || /^application\/([a-z0-9.+-]*\+)?json\b/.test(type);
    if (sameOrigin && nonSimple) return next();
    return problem(403, {
      code: "csrf",
      detail: sameOrigin
        ? "Cookie-authenticated writes must send `X-Requested-With` or a JSON body (CSRF protection)."
        : `Cross-site request rejected (Sec-Fetch-Site: ${site}).`,
    });
  };
}
