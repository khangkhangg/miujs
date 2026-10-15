import type { Middleware } from "../core/app.ts";
import { problem } from "../core/errors.ts";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfOptions {
  /** Extra origins allowed to send cookie-authenticated writes, e.g. "https://admin.example.com". */
  trustedOrigins?: string[];
  /**
   * For JSON/upload APIs: also require `X-Requested-With` or a JSON content type, which browsers only send
   * cross-origin after a CORS preflight. Leave off for HTML form posts.
   */
  requireNonSimple?: boolean;
}

/**
 * CSRF protection for cookie-authenticated writes (HTML forms and APIs). Cookies are the only credential a
 * browser attaches on its own, so an unsafe request passes when it carries no cookie, carries an
 * `Authorization` header, or comes from the app's own origin: `Sec-Fetch-Site: same-origin`/`none`, or — on
 * browsers that don't send fetch metadata — an `Origin` equal to the request's origin. Non-browser clients
 * that send neither header pass. Complements `SameSite=Lax` session cookies.
 */
export function csrf(opts: CsrfOptions = {}): Middleware {
  const trusted = new Set((opts.trustedOrigins ?? []).map((o) => o.replace(/\/+$/, "")));
  return (c, next) => {
    if (SAFE.has(c.method)) return next();
    const h = c.req.headers;
    if (h.has("authorization") || !h.has("cookie")) return next();
    const origin = h.get("origin");
    const site = h.get("sec-fetch-site");
    let ok: boolean;
    if (origin && trusted.has(origin)) ok = true;
    else if (site) ok = site === "same-origin" || site === "none";
    else ok = !origin || origin === c.url.origin;
    if (ok && opts.requireNonSimple) {
      const type = (h.get("content-type") ?? "").toLowerCase();
      if (!h.has("x-requested-with") && !/^application\/([a-z0-9.+-]*\+)?json\b/.test(type)) {
        return problem(403, {
          code: "csrf",
          detail: "Cookie-authenticated writes must send `X-Requested-With` or a JSON body (CSRF protection).",
        });
      }
    }
    if (ok) return next();
    return problem(403, {
      code: "csrf",
      detail: `Cross-site request rejected (${site ? `Sec-Fetch-Site: ${site}` : `Origin: ${origin}`}). Use a same-origin form or an Authorization header.`,
    });
  };
}
