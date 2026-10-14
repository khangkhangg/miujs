import type { Context } from "../core/context.ts";

/** Headers of `c.res`, rebuilding the Response first if its headers are immutable (e.g. from `fetch`). */
export function resHeaders(c: Context<any, any>): Headers {
  try {
    c.res.headers.set("x-miu-probe", "1");
    c.res.headers.delete("x-miu-probe");
  } catch {
    c.res = new Response(c.res.body, c.res);
  }
  return c.res.headers;
}

/** Append a token to a comma-separated header such as `Vary`, without duplicates. */
export function appendToken(h: Headers, name: string, token: string): void {
  const cur = h.get(name);
  if (!cur) return h.set(name, token);
  const parts = cur.split(",").map((s) => s.trim().toLowerCase());
  if (!parts.includes(token.toLowerCase()) && !parts.includes("*")) h.set(name, `${cur}, ${token}`);
}
