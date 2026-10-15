// Who may open a tour in the viewer: published + public/unlisted for everyone; private or
// password-protected tours need a share link or an unlock cookie; drafts only for editors.
import type { Context } from "miujs";
import { verifyTourToken } from "./crypto.ts";
import { tourErrors } from "./errors.ts";
import { orgScope, type TourRuntime } from "./runtime.ts";
import type { Tour, TourStore } from "./store.ts";

/** How the viewer got in. Only `public` responses may be cached by browsers and CDNs. */
export type ViewAccess = "public" | "private";

export const unlockCookie = (tourId: string) => `miu_tour_${tourId}`;

function isEditor(ctx: Context, tour: Tour): boolean {
  const can = (ctx as unknown as { can?: (p: string) => boolean }).can;
  if (typeof can !== "function" || !ctx.user) return false;
  const org = orgScope(ctx);
  if (org !== undefined && (tour.orgId ?? null) !== org) return false;
  try {
    return can.call(ctx, "tours:read") === true;
  } catch {
    return false;
  }
}

export async function viewAccess(rt: TourRuntime, ctx: Context, s: TourStore, tour: Tour, share?: string | null): Promise<ViewAccess> {
  if (isEditor(ctx, tour)) return "private";
  if (tour.status !== "published") throw tourErrors.notFound(tour.slug);
  const locked = tour.visibility === "private" || tour.hasPassword;
  if (!locked) return tour.visibility === "public" ? "public" : "private";
  const secrets = rt.secrets(ctx.env, ctx.log);
  const nowSec = Math.floor(rt.now() / 1000);
  const v = await s.tourSecrets(tour.id);
  if (share) {
    const p = await verifyTourToken(secrets, share, "share", nowSec);
    if (p.tour !== tour.id) throw tourErrors.tokenInvalid("this link is for another tour");
    if (p.v !== v?.shareVersion) throw tourErrors.tokenInvalid("this link was revoked");
    return "private";
  }
  const cookie = ctx.cookies.get(unlockCookie(tour.id));
  if (cookie && tour.hasPassword) {
    try {
      const p = await verifyTourToken(secrets, cookie, "unlock", nowSec);
      if (p.tour === tour.id && p.v === v?.passwordVersion) return "private";
    } catch {
      // An old or foreign cookie: ask for the password again.
    }
  }
  throw tourErrors.locked(tour.slug);
}

/** Loads a tour for viewers by id or slug, ignoring org scope (viewers are anonymous). */
export async function loadViewable(rt: TourRuntime, ctx: Context, ref: string): Promise<{ s: TourStore; tour: Tour }> {
  const s = await rt.data(ctx.env);
  const tour = await s.findTour(ref);
  if (!tour) throw tourErrors.notFound(ref);
  return { s, tour };
}
