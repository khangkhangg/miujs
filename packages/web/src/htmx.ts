import type { Context } from "miujs";
import { webErrors } from "./errors.ts";
import { render, type HtmlString, type RenderOptions } from "./html.ts";

/** True when the request was sent by htmx (`HX-Request: true`). */
export function isHtmx(ctx: Pick<Context, "headers">): boolean {
  return ctx.headers.get("hx-request") === "true";
}

/** Headers of `res`, copied into a new Response first when they are immutable. */
function withHeader(res: Response, name: string, value: string): Response {
  try {
    res.headers.set(name, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set(name, value);
    return copy;
  }
}

/** Header-safe JSON: non-ASCII becomes \uXXXX so it survives as a ByteString. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/**
 * Tell htmx to do a full-page navigation to `url` (`HX-Redirect`). Only paths and http(s)
 * URLs are accepted, since htmx assigns the value to `location.href`.
 */
export function hxRedirect(url: string): Response {
  const u = String(url).trim();
  const ok = (u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/\\")) || /^https?:\/\//i.test(u);
  if (!ok || /[\0-\x1f]/.test(u)) throw webErrors.hxUrl(String(url));
  return new Response(null, { status: 204, headers: { "hx-redirect": u } });
}

/**
 * Fire a client-side event via `HX-Trigger`. With no `response`, returns an empty 204 (htmx
 * swaps nothing); pass a response to add the header to it.
 *
 * ```ts
 * return hxTrigger("toast", { message: "Saved" });
 * return hxTrigger("saved", undefined, render(html`<tr>…</tr>`));
 * ```
 */
export function hxTrigger(event: string, detail?: unknown, response?: Response): Response {
  const value = detail === undefined ? event : asciiJson({ [event]: detail });
  if (/[\0-\x1f\x7f-￿]/.test(value)) throw webErrors.config(`Invalid htmx event name ${JSON.stringify(event)}`, "Use a plain ASCII event name such as `saved` or `cart:updated`.");
  return withHeader(response ?? new Response(null, { status: 204 }), "hx-trigger", value);
}

/**
 * Render `partial` alone for htmx requests and wrapped in `layout` for normal page loads
 * (and `hx-boost` navigations). Sets `Vary: HX-Request` so caches keep the two apart.
 */
export function renderPage(ctx: Pick<Context, "headers">, partial: HtmlString, layout: (body: HtmlString) => HtmlString, opts: RenderOptions = {}): Response {
  const partialOnly = isHtmx(ctx) && ctx.headers.get("hx-boosted") !== "true";
  const res = render(partialOnly ? partial : layout(partial), opts);
  res.headers.append("vary", "HX-Request");
  return res;
}
