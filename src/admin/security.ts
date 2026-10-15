import type { Context } from "../core/context.ts";
import { HttpError } from "../core/errors.ts";
import { timingSafeEqual, toBase64Url, utf8 } from "../batteries/auth/encoding.ts";
import type { Session } from "../batteries/session.ts";

/**
 * CSRF defence for cookie-authenticated admin writes (two independent layers):
 *
 * 1. Same-origin check: a trusted `Origin` passes; otherwise `Sec-Fetch-Site` (set by the browser, unforgeable
 *    from a page) must be `same-origin`, or, on browsers without it, `Origin` must equal the request origin.
 * 2. Synchronizer token: `GET <admin>/api/_csrf` stores a random token in the server-side session, bound to the
 *    current session id, and the client echoes it in `x-csrf-token`. Session-stored rather than double-submit
 *    cookie because a sibling subdomain can plant cookies (cookie tossing) but cannot read or write the server
 *    session, and binding to the session id means a token never survives `login()` (which regenerates the id).
 *
 * Requests with an `Authorization` header (bearer tokens from agents and scripts) are exempt: browsers never
 * attach that header to a cross-site request without a CORS preflight the app would have to allow.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const KEY = "miu.admin.csrf";

interface StoredToken {
  sid: string;
  token: string;
}

export function csrfFailed(detail: string): HttpError {
  return new HttpError(403, detail, { code: "csrf_failed" });
}

export async function issueCsrfToken(c: Context<any, any>): Promise<string> {
  const s = c.get("session") as Session | undefined;
  if (!s) throw new HttpError(501, "The admin needs the sessions() middleware to issue CSRF tokens", { code: "sessions_required" });
  const cur = await s.get<StoredToken>(KEY);
  if (cur && cur.sid === s.id && typeof cur.token === "string") return cur.token;
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await s.set(KEY, { sid: s.id, token } satisfies StoredToken);
  return token;
}

export async function checkCsrf(c: Context<any, any>, trustedOrigins: readonly string[]): Promise<void> {
  if (SAFE.has(c.method)) return;
  const h = c.req.headers;
  if (h.has("authorization")) return;

  const origin = h.get("origin");
  if (!(origin && trustedOrigins.includes(origin))) {
    const site = h.get("sec-fetch-site");
    if (site !== null) {
      if (site !== "same-origin") throw csrfFailed(`Cross-site request refused (Sec-Fetch-Site: ${site})`);
    } else if (origin !== null && origin !== c.url.origin) {
      throw csrfFailed("Cross-origin request refused (Origin does not match)");
    }
  }

  const sent = h.get("x-csrf-token") ?? "";
  const s = c.get("session") as Session | undefined;
  const cur = s ? await s.get<StoredToken>(KEY) : undefined;
  if (!sent || !s || !cur || cur.sid !== s.id || !timingSafeEqual(utf8(sent), utf8(String(cur.token)))) {
    throw csrfFailed("Missing or invalid x-csrf-token header. Fetch one from the admin's api/_csrf endpoint.");
  }
}

/** 16 random bytes for a CSP nonce. */
export function cspNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}
