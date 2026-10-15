// Viewer-facing routes: manifest, tiles, unlock (password) and share links.
import { route, t, type Context, type RouteDef } from "miujs";
import { KeyedLimiter } from "@miujs/realtime";
import { loadViewable, unlockCookie, viewAccess } from "../access.ts";
import { signTourToken, verifyPassword, verifyTourToken } from "../crypto.ts";
import { tourErrors } from "../errors.ts";
import { buildManifest } from "../manifest.ts";
import type { TourRuntime } from "../runtime.ts";
import * as S from "../schemas.ts";
import { loadTour } from "./admin.ts";

const TILE_PATH = /^(?:\d{1,2}\/(?:[fblrud]\/)?\d{1,4}_\d{1,4}|preview)\.(jpg|webp|png)$/;
const TILE_TYPES: Record<string, string> = { jpg: "image/jpeg", webp: "image/webp", png: "image/png" };

/** The rooms plugin's path prefix (e.g. "/rooms"), when live tours are on. */
export function livePath(rt: TourRuntime): string | null {
  const live = rt.opts.live as (TourRuntime["opts"]["live"] & { inspect?: () => unknown }) | undefined;
  if (!live) return null;
  const p = (live.inspect?.() as { path?: string } | undefined)?.path;
  return typeof p === "string" ? p.replace(/\/:type\/:id$/, "") : "/rooms";
}

function isHttps(ctx: Context): boolean {
  return ctx.url.protocol === "https:" || ctx.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
}

export function viewerRoutes(rt: TourRuntime): RouteDef[] {
  const base = rt.basePath;
  const unlockLimiter = new KeyedLimiter({ perSecond: 10 / 60, burst: 10 });

  const manifest = route.get(`${base}/:tour/manifest.json`, {
    name: "tours_manifest",
    summary: "The viewer manifest of a tour: scenes, hotspots, floor plans, asset states and signed asset URLs",
    description: "Public tours: cacheable URLs. Private/unlisted/password tours: short-lived URLs; pass ?share=<token> or the unlock cookie.",
    tags: ["tours"],
    params: S.tourParams,
    query: t.object({ share: t.optional(t.string({ maxLength: 2048 })) }),
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadViewable(rt, ctx, c.params.tour);
      const access = await viewAccess(rt, ctx, s, tour, c.query.share);
      const m = await buildManifest(rt, ctx, s, tour, access, livePath(rt), c.query.share);
      c.set.headers.set("cache-control", access === "public" ? "public, max-age=60" : "private, no-store");
      if (tour.visibility !== "public") c.set.headers.set("x-robots-tag", "noindex");
      return m;
    },
  });

  const tiles = route.get(`${base}/_tiles/:token/*path`, {
    name: "tours_tiles",
    summary: "Serve one panorama tile through a prefix-scoped signed token",
    tags: ["tours"],
    mcp: false,
    internal: true,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const path = String(c.params.path ?? "");
      const m = TILE_PATH.exec(path);
      if (!m) throw tourErrors.invalid(`Not a tile path: ${JSON.stringify(path.slice(0, 80))}`, "Use the tile URL template from the manifest unchanged (e.g. 2/f/0_1.jpg).");
      const nowSec = Math.floor(rt.now() / 1000);
      const p = await verifyTourToken(rt.secrets(ctx.env, ctx.log), c.params.token, "tiles", nowSec);
      const obj = await rt.files(ctx.env).get(`${p.prefix}/${path}`);
      if (!obj) return Response.json({ error: { code: "MIU_E_TOUR_TILE_NOT_FOUND", message: "No such tile", fix: "Check the level/face/row/col against the manifest's levels." } }, { status: 404 });
      const maxAge = Math.max(0, Math.min(p.pub ? 86_400 : 600, p.e - nowSec));
      return new Response(obj.body, {
        headers: {
          "content-type": TILE_TYPES[m[1]],
          "content-length": String(obj.size),
          etag: `"${obj.etag}"`,
          // Output prefixes are unique per processing run, so a tile never changes.
          "cache-control": p.pub ? `public, max-age=${maxAge}, immutable` : `private, max-age=${maxAge}`,
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": "*",
        },
      });
    },
  });

  const unlock = route.post(`${base}/:tour/unlock`, {
    name: "tours_unlock",
    summary: "Unlock a password-protected tour; sets a cookie that opens it for a while",
    tags: ["tours"],
    mcp: false,
    params: S.tourParams,
    body: t.object({ password: t.string({ maxLength: 200 }) }),
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadViewable(rt, ctx, c.params.tour);
      if (tour.status !== "published") throw tourErrors.notFound(c.params.tour);
      if (!unlockLimiter.take(`${ctx.ip ?? "unknown"}|${tour.id}`, rt.now())) throw tourErrors.rateLimited(60);
      const v = await s.tourSecrets(tour.id);
      if (!v?.passwordHash || !(await verifyPassword(c.body.password, v.passwordHash))) throw tourErrors.passwordWrong();
      const ttl = rt.opts.unlockTtl ?? 12 * 3600;
      const e = Math.floor(rt.now() / 1000) + ttl;
      const token = await signTourToken(rt.secrets(ctx.env, ctx.log), { p: "unlock", tour: tour.id, v: v.passwordVersion, e });
      const https = isHttps(ctx);
      // SameSite=None lets the cookie work inside an embedding iframe (needs https).
      ctx.cookies.set(unlockCookie(tour.id), token, { httpOnly: true, path: base, maxAge: ttl, secure: https, sameSite: https ? "None" : "Lax" });
      return { ok: true, expiresAt: e };
    },
  });

  const share = route.post(`${base}/:tour/share`, {
    name: "tours_share",
    summary: "Create a signed share link that opens a private or password-protected tour until it expires",
    tags: ["tours"],
    permission: "tours:write",
    mcp: false,
    status: 201,
    params: S.tourParams,
    body: t.object({ expiresIn: t.optional(t.integer({ min: 60, max: 90 * 86_400, description: "Seconds. Default 7 days." })) }),
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadTour(rt, ctx, c.params.tour);
      const v = await s.tourSecrets(tour.id);
      const expiresAt = Math.floor(rt.now() / 1000) + (c.body.expiresIn ?? 7 * 86_400);
      const token = await signTourToken(rt.secrets(ctx.env, ctx.log), { p: "share", tour: tour.id, v: v!.shareVersion, e: expiresAt });
      return { token, expiresAt, url: `${ctx.url.origin}${base}/${tour.slug}/view?share=${token}` };
    },
  });

  const revoke = route.post(`${base}/:tour/share/revoke`, {
    name: "tours_share_revoke",
    summary: "Revoke every share link issued for a tour so far",
    tags: ["tours"],
    permission: "tours:write",
    mcp: false,
    params: S.tourParams,
    handler: async (c) => {
      const { s, tour } = await loadTour(rt, c as unknown as Context, c.params.tour);
      await s.revokeShares(tour.id);
    },
  });

  return [manifest, tiles, unlock, share, revoke];
}
