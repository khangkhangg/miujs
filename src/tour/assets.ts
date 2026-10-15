import type { Context } from "../core/context.ts";
import { problem } from "../core/errors.ts";
import { ASSETS } from "./client/assets.generated.ts";

/** URL of an embedded client module, versioned by content hash (served `immutable`). */
export function assetUrl(base: string, name: string): string {
  const a = ASSETS[name];
  return `${base}/assets/${name}${a ? `?v=${a.hash}` : ""}`;
}

/** Serve an embedded client module with an ETag; versioned URLs are cached for a year. */
export function assetResponse(c: Context<any, any>, name: string): Response {
  const a = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined;
  if (!a) return problem(404, { detail: `No asset ${name}` });
  const etag = `"${a.hash}"`;
  const headers = {
    etag,
    "cache-control": c.url.searchParams.get("v") === a.hash ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "x-content-type-options": "nosniff",
  };
  if ((c.req.headers.get("if-none-match") ?? "").split(",").some((v) => v.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(a.body, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
}
