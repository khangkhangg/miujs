import { serializeCookie, type Context, type CookieOptions } from "miujs";

/**
 * Sets a cookie whose value the old framework reads verbatim. `ctx.cookies.set` URL-encodes the
 * value, which PHP decodes but Django does not (a signed value's ":" would arrive as "%3A").
 * When encoding would change the value, the raw header is queued on the same list core uses for
 * `ctx.cookies.set`, so it is applied to every response (including Responses returned by handlers).
 */
export function setLegacyCookie(ctx: Context, name: string, value: string, opts: CookieOptions): void {
  if (encodeURIComponent(value) === value) {
    ctx.cookies.set(name, value, opts);
    return;
  }
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) {
    // Not a valid raw cookie value: fall back to encoding.
    ctx.cookies.set(name, value, opts);
    return;
  }
  const header = serializeCookie(name, "", opts).replace(`${name}=`, `${name}=${value}`);
  // Touch the cookie jar so core treats this request as having cookies to set, then queue ours.
  const internal = ctx as unknown as { _setCookies?: string[] | null };
  if ("_setCookies" in (ctx as object)) {
    (internal._setCookies ??= []).push(header);
  } else {
    ctx.set.headers.append("set-cookie", header);
  }
}
