// bridgeAuth: users signed in to the old app are signed in to MiuJS too.

import { definePlugin, type AuthUser, type Context } from "miujs";
import { migrateError } from "./errors.ts";
import type { LegacySession, LegacySessionSource } from "./types.ts";

export interface BridgeAuthOptions {
  /** laravelSession(...) or djangoSession(...). */
  from: LegacySessionSource;
  /** Loads the MiuJS user for the old app's user id. Return null to stay signed out. */
  findUser: (id: string, ctx: Context) => Promise<AuthUser | null | undefined> | AuthUser | null | undefined;
  /**
   * Same-origin check for POST/PUT/PATCH/DELETE signed in through the old cookie (Origin or
   * Referer must match this host or `trustedOrigins`). Default true: the old app's CSRF token
   * does not protect MiuJS routes.
   */
  csrf?: boolean;
  trustedOrigins?: string[];
}

const LEGACY = "migrate.legacySession";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The old app's session on this request, after bridgeAuth ran. */
export function getLegacySession(ctx: Context): LegacySession | null {
  return (ctx.state[LEGACY] as LegacySession | null | undefined) ?? null;
}

function originOf(v: string): string | null {
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}

/** Put it after your own auth plugin: an existing `ctx.user` is never replaced. */
export function bridgeAuth(opts: BridgeAuthOptions) {
  const csrf = opts.csrf ?? true;
  const trusted = new Set((opts.trustedOrigins ?? []).map((o) => originOf(o)).filter((o): o is string => !!o));

  function sameOrigin(ctx: Context): boolean {
    const here = ctx.url.origin;
    const origin = ctx.headers.get("origin");
    const referer = ctx.headers.get("referer");
    const o = origin !== null ? originOf(origin) : referer ? originOf(referer) : null;
    return o !== null && (o === here || trusted.has(o));
  }

  return definePlugin({
    name: "migrate-bridge-auth",
    async onRequest(ctx) {
      if (ctx.user) return;
      const session = await opts.from.read(ctx);
      ctx.state[LEGACY] = session;
      if (!session?.userId) return;
      if (csrf && UNSAFE.has(ctx.method) && !sameOrigin(ctx)) {
        throw migrateError(
          "CSRF",
          403,
          `Cross-site ${ctx.method} blocked: the old app's session cookie was sent without a matching Origin/Referer`,
          "Send the request from this site (browsers add Origin), add the other site to bridgeAuth({ trustedOrigins }), or use a bearer token for API clients.",
        );
      }
      const user = await opts.findUser(session.userId, ctx);
      if (user) ctx.user = user;
    },
    inspect() {
      return { from: opts.from.inspect(), csrf, trustedOrigins: [...trusted] };
    },
  });
}
