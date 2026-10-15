// GET /tours/:tour/view: the embeddable viewer page (or a lock page for protected tours).
import { isMiuError, route, t, type Context, type RouteDef } from "miujs";
import { html, raw, render, type HtmlString } from "@miujs/web";
import { loadViewable, viewAccess } from "../access.ts";
import { tourErrors } from "../errors.ts";
import { buildManifest, type Manifest } from "../manifest.ts";
import { tourCsp, tourPage } from "../page.ts";
import type { TourRuntime } from "../runtime.ts";
import * as S from "../schemas.ts";
import type { Tour } from "../store.ts";
import { livePath } from "./viewer.ts";

const CODE_RE = /^\d{6}$/;

function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Every origin a manifest's URLs point at, other than the page's own. */
export function manifestOrigins(m: Manifest, self: string): string[] {
  const out = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u !== "string") return;
    try {
      const o = new URL(u).origin;
      if (o !== self && o !== "null") out.add(o);
    } catch {}
  };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "url" || k === "tiles" || k === "preview" ? add(x) : walk(x));
  };
  walk(m.scenes);
  walk(m.floorPlans);
  return [...out];
}

const UNLOCK_JS = String.raw`
const form = document.querySelector(".miu-tour-unlock");
const msg = form.querySelector("[role=alert]");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msg.textContent = "";
  const r = await fetch(form.action, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: form.password.value }) });
  if (r.ok) location.reload();
  else msg.textContent = r.status === 429 ? "Too many attempts. Wait a minute and try again." : "That password is not right.";
});
`;

function lockPage(tour: Tour, unlockUrl: string, nonce: string): HtmlString {
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${tour.title}</title>
<style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem}</style></head>
<body>
<h1>${tour.title}</h1>
${tour.hasPassword
  ? html`<form class="miu-tour-unlock" method="post" action="${unlockUrl}"><label>Password <input type="password" name="password" required autocomplete="current-password"></label> <button type="submit">Open tour</button><p role="alert"></p></form>
<script type="module" nonce="${nonce}">${raw(UNLOCK_JS)}</script>`
  : html`<p>This tour is private. Open it with the share link you were given.</p>`}
</body>
</html>
`;
}

export function pageRoutes(rt: TourRuntime): RouteDef[] {
  const base = rt.basePath;
  const assets = rt.opts.viewerAssets ?? "cdn";

  const view = route.get(`${base}/:tour/view`, {
    name: "tours_view",
    summary: "The embeddable tour viewer page (HTML). ?live=<6-digit code> joins a live guided tour; ?share=<token> opens a shared private tour",
    tags: ["tours"],
    mcp: false,
    params: S.tourParams,
    query: t.object({ share: t.optional(t.string({ maxLength: 2048 })), live: t.optional(t.string({ maxLength: 12 })) }),
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const { s, tour } = await loadViewable(rt, ctx, c.params.tour);
      // Reuse secureHeaders' nonce when it runs, so both agree; otherwise make one.
      const nonce = typeof ctx.state.cspNonce === "string" ? ctx.state.cspNonce : (ctx.state.cspNonce = newNonce());
      const frameAncestors = tour.allowedEmbedOrigins.length ? tour.allowedEmbedOrigins : ["'self'"];
      const headers = new Headers({ "cache-control": "private, no-store" });
      if (tour.visibility !== "public" || tour.hasPassword) {
        headers.set("x-robots-tag", "noindex");
        headers.set("referrer-policy", "no-referrer");
      }
      let access;
      try {
        access = await viewAccess(rt, ctx, s, tour, c.query.share);
      } catch (err) {
        if (isMiuError(err) && err.code === "MIU_E_TOUR_LOCKED") {
          headers.set("content-security-policy", tourCsp({ nonce, assets: { basePath: "" }, frameAncestors }));
          return render(lockPage(tour, `${base}/${tour.slug}/unlock`, nonce), { status: 401, headers });
        }
        throw err;
      }
      if (tour.privacy === "strict" && assets === "cdn") throw tourErrors.strictCdn();
      const lp = livePath(rt);
      const live = lp && c.query.live && CODE_RE.test(c.query.live) ? { code: c.query.live, roomsPath: lp } : null;
      const manifest = await buildManifest(rt, ctx, s, tour, access, lp, c.query.share);
      const manifestUrl = `${base}/${tour.slug}/manifest.json${c.query.share ? `?share=${encodeURIComponent(c.query.share)}` : ""}`;
      headers.set("content-security-policy", tourCsp({ nonce, assets, frameAncestors, assetOrigins: manifestOrigins(manifest, ctx.url.origin) }));
      const noindex = tour.visibility !== "public" || tour.hasPassword || !!c.query.share;
      return render(tourPage(manifestUrl, { nonce, manifest, assets, live, noindex }), { headers });
    },
  });

  return [view];
}


