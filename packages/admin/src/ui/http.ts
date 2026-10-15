// Server helpers for the admin UI: internal sub-requests through the app (so every read and
// write goes through the same routes, permission checks and validation as the API), the
// active organization, redirects and permission checks.

import type { App, Context } from "miujs";

export const ORG_COOKIE = "miu_admin_org";
const ORG_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface SubResponse {
  status: number;
  ok: boolean;
  data: any;
  headers: Headers;
}

/** Request headers not forwarded to sub-requests (they describe the outer body). */
const SKIP = new Set(["content-type", "content-length", "transfer-encoding", "connection", "expect", "x-org-id"]);

export function cookieOrg(ctx: Context): string | null {
  const v = ctx.cookies.get(ORG_COOKIE);
  return v && ORG_ID.test(v) ? v : null;
}

/** The org the UI acts in: explicit header, then the verified ctx.org, then the UI cookie. */
export function orgOf(ctx: Context): string | null {
  const h = ctx.headers.get("x-org-id");
  if (h && ORG_ID.test(h)) return h;
  const org = (ctx as { org?: { id?: unknown } | null }).org;
  if (org && typeof org.id === "string") return org.id;
  return cookieOrg(ctx);
}

export function platformOf(ctx: Context): any {
  return (ctx as unknown as { _platform?: unknown })._platform ?? { runtime: ctx.runtime };
}

/**
 * Calls a route of this app as the current user (same cookies/credentials, same origin) and
 * parses the JSON answer. The inner request runs the full pipeline: session, CSRF, auth, access.
 */
export async function sub(app: App, ctx: Context, method: string, path: string, o: { body?: unknown; org?: string | null } = {}): Promise<SubResponse> {
  const headers = new Headers();
  ctx.req.headers.forEach((v, k) => {
    if (!SKIP.has(k)) headers.set(k, v);
  });
  headers.set("accept", "application/json");
  const org = o.org === undefined ? orgOf(ctx) : o.org;
  if (org) headers.set("x-org-id", org);
  let body: string | undefined;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers.set("content-type", "application/json");
  }
  const req = new Request(new URL(path, ctx.url.origin), { method, headers, body });
  const res = await app.dispatch(req, ctx.env, platformOf(ctx));
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { message: text.slice(0, 300) } };
  }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

export function redirect(location: string, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("location", location);
  return new Response(null, { status: 303, headers: h });
}

/** A same-site path to go back to, or `fallback`. Rejects //host, /\host, schemes and controls. */
export function safeNext(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\0-\x1f\\]/.test(raw)) return fallback;
  return raw;
}

/** Permission check that also works without @miujs/access (then: the admin role). */
export function can(ctx: Context, permission: string): boolean {
  const c = (ctx as { can?: unknown }).can;
  if (typeof c === "function") return !!(c as (p: string) => boolean).call(ctx, permission);
  return !!ctx.user?.roles?.includes("admin");
}

export function orgCookie(ctx: Context, id: string | null): string {
  const secure = ctx.url.protocol === "https:" ? "; Secure" : "";
  return id === null ? `${ORG_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}` : `${ORG_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
}

export const PAGE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };
