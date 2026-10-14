import type { Middleware } from "../../core/app.ts";
import type { Context } from "../../core/context.ts";
import { problem } from "../../core/errors.ts";
import type { Session } from "../session.ts";

export interface AuthOptions<U> {
  /** Load the user whose id is stored in the session (after `login()`). */
  loadUser: (id: string, c: Context<any, any>) => Promise<U | undefined>;
  /** Resolve an `Authorization: Bearer <token>` (API key, JWT, ...) to a user. */
  bearer?: (token: string, c: Context<any, any>) => Promise<U | undefined>;
}

/**
 * Resolve the current user from a bearer token or the session, and expose it as
 * `c.get("user")` / `currentUser(c)`. Session login requires `sessions()` to run first.
 */
export function auth<U = unknown>(opts: AuthOptions<U>): Middleware {
  return async (c, next) => {
    let user: U | undefined;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.headers.get("authorization") ?? "");
    if (m && opts.bearer) {
      user = await opts.bearer(m[1]!, c);
    } else {
      const s = c.get("session") as Session | undefined;
      const id = s ? await s.get<string | number>("userId") : undefined;
      if (id !== undefined && id !== null) user = await opts.loadUser(String(id), c);
    }
    c.set("user", user);
    await next();
  };
}

/** Log a user in: regenerates the session id (fixation protection) and stores the user id. */
export async function login(c: Context<any, any>, user: { id: string | number }): Promise<void> {
  const s = requireSession(c, "login");
  await s.regenerate();
  await s.set("userId", String(user.id));
  c.set("user", user);
}

/** Log out: destroys the session and clears its cookie. */
export async function logout(c: Context<any, any>): Promise<void> {
  await requireSession(c, "logout").destroy();
  c.set("user", undefined);
}

/** The authenticated user, if any. */
export function currentUser<U = unknown>(c: Context<any, any>): U | undefined {
  return c.get("user") as U | undefined;
}

/**
 * Reject unauthenticated requests. Browsers (Accept: text/html) are redirected to
 * `redirectTo?next=<path>` when set; everyone else gets a 401 problem+json.
 */
export function requireAuth(opts: { redirectTo?: string } = {}): Middleware {
  return async (c, next) => {
    if (c.get("user")) return next();
    if (opts.redirectTo && (c.req.headers.get("accept") ?? "").includes("text/html")) {
      const sep = opts.redirectTo.includes("?") ? "&" : "?";
      return c.redirect(`${opts.redirectTo}${sep}next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
    }
    return problem(
      401,
      {
        code: "unauthenticated",
        detail:
          "Authentication required. Send an `Authorization: Bearer <token>` header with an API key or access token, or sign in to obtain a session cookie.",
      },
      { "www-authenticate": "Bearer" },
    );
  };
}

function requireSession(c: Context<any, any>, fn: string): Session {
  const s = c.get("session") as Session | undefined;
  if (!s) throw new Error(`${fn}() needs a session: the sessions() middleware must run before it`);
  return s;
}
