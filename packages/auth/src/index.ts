// @miujs/auth — email/password accounts, sessions and API tokens. Sets `ctx.user`; core enforces
// `route.auth`. Needs `session()` earlier in `plugins`.

import { definePlugin, errors, route, t, type AuthUser, type CloudflareNeeds, type Context, type Env } from "miujs";
import { getSession, hex, randomId, sha256, timingSafeEqual, utf8, base64urlEncode, randomBytes } from "@miujs/session";
import { hashPassword, needsRehash, verifyPassword, type PasswordOptions } from "./password.ts";
import { memoryUserStore, type StoredUser, type UserStore } from "./store.ts";

export * from "./password.ts";
export * from "./store.ts";

export interface TurnstileOptions {
  /** Turnstile secret key. Default: `env.TURNSTILE_SECRET_KEY`. */
  secretKey?: string;
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}

export interface AuthOptions {
  /** Default `memoryUserStore()` (dev only). Use `dbUserStore(db)` for real apps. */
  users?: UserStore;
  /** Default `/auth`. */
  basePath?: string;
  password?: PasswordOptions;
  /** Roles given to newly registered users. Default `[]`. */
  defaultRoles?: string[];
  /** Default 8. */
  minPasswordLength?: number;
  /** Serve POST /register. Default true. */
  register?: boolean;
  /** Bot protection on register/login. */
  turnstile?: TurnstileOptions;
  /** Prefix for API tokens, so leaked tokens are easy to scan for. Default `miu_`. */
  tokenPrefix?: string;
}

const MAX_PASSWORD = 1024;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const UserSchema = t.object({
  id: t.string(),
  email: t.optional(t.string()),
  name: t.optional(t.nullable(t.string())),
  roles: t.array(t.string()),
});

function publicUser(u: StoredUser): AuthUser {
  return { id: u.id, email: u.email, name: u.name ?? undefined, roles: u.roles };
}

const invalidLogin = () =>
  errors.custom({
    code: "MIU_E_AUTH_INVALID",
    status: 401,
    message: "Invalid email or password",
    fix: "Check the email and password. Register first if you do not have an account.",
  });

const invalidToken = () =>
  errors.custom({
    code: "MIU_E_AUTH_TOKEN_INVALID",
    status: 401,
    message: "Invalid or expired API token",
    fix: "Create a new token with POST /auth/tokens and send it as `Authorization: Bearer <token>`.",
  });

function requireSession(ctx: Context) {
  const s = getSession(ctx);
  if (!s) {
    throw errors.config("MIU_E_AUTH_SESSION_REQUIRED", "auth() needs the session plugin", "Add session() before auth() in miu({ plugins: [session(), auth()] }).");
  }
  return s;
}

/**
 * Accounts and sign-in.
 *
 * ```ts
 * miu({ plugins: [session(), auth({ users: dbUserStore(d1("DB")) })] })
 * ```
 */
export function auth(opts: AuthOptions = {}) {
  const users = opts.users ?? memoryUserStore();
  const base = (opts.basePath ?? "/auth").replace(/\/+$/, "");
  const pw = opts.password ?? {};
  const minLen = opts.minPasswordLength ?? 8;
  const prefix = opts.tokenPrefix ?? "miu_";
  let dummyHash: Promise<string> | undefined;

  async function checkTurnstile(ctx: Context, token: string | undefined) {
    if (!opts.turnstile) return;
    const fail = (why: string) =>
      errors.custom({
        code: "MIU_E_AUTH_TURNSTILE_FAILED",
        status: 403,
        message: `Bot check failed: ${why}`,
        fix: "Render the Cloudflare Turnstile widget in the form and send its token as `cf-turnstile-response`.",
      });
    const secret = opts.turnstile.secretKey ?? (ctx.env?.TURNSTILE_SECRET_KEY as string | undefined);
    if (!secret) throw errors.config("MIU_E_AUTH_TURNSTILE_SECRET_MISSING", "Turnstile is on but no secret key is set", "Set TURNSTILE_SECRET_KEY or pass auth({ turnstile: { secretKey } }).");
    token ??= ctx.headers.get("cf-turnstile-response") ?? undefined;
    if (!token) throw fail("missing cf-turnstile-response");
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    const ip = ctx.headers.get("cf-connecting-ip");
    if (ip) form.append("remoteip", ip);
    let ok = false;
    try {
      const res = await (opts.turnstile.fetch ?? fetch)(SITEVERIFY, { method: "POST", body: form });
      ok = res.ok && ((await res.json()) as { success?: boolean }).success === true;
    } catch (err) {
      ctx.log.warn("turnstile siteverify failed", { err });
    }
    if (!ok) throw fail("token rejected");
  }

  function checkPassword(password: string) {
    if (password.length < minLen || password.length > MAX_PASSWORD) {
      throw errors.custom({
        code: "MIU_E_AUTH_PASSWORD_WEAK",
        status: 400,
        message: `Password must be ${minLen}–${MAX_PASSWORD} characters`,
        fix: `Choose a password of at least ${minLen} characters (a passphrase works well).`,
      });
    }
  }

  function signIn(ctx: Context, user: StoredUser) {
    const s = requireSession(ctx);
    s.regenerate();
    s.set("userId", user.id);
    ctx.user = publicUser(user);
  }

  const Credentials = {
    email: t.string({ format: "email", maxLength: 254 }),
    password: t.string({ maxLength: MAX_PASSWORD }),
    "cf-turnstile-response": t.optional(t.string({ maxLength: 4096 })),
  };

  const registerRoute = route.post(`${base}/register`, {
    name: "auth_register",
    summary: "Create an account with email and password, and sign in",
    tags: ["auth"],
    mcp: false,
    status: 201,
    body: t.object({ ...Credentials, name: t.optional(t.string({ maxLength: 200 })) }),
    response: t.object({ user: UserSchema }),
    handler: async (ctx) => {
      await checkTurnstile(ctx as unknown as Context, ctx.body["cf-turnstile-response"]);
      checkPassword(ctx.body.password);
      const passwordHash = await hashPassword(ctx.body.password, pw);
      const user = await users.createUser({ email: ctx.body.email, name: ctx.body.name ?? null, roles: [...(opts.defaultRoles ?? [])], passwordHash }, ctx.env);
      if (!user) {
        throw errors.custom({
          code: "MIU_E_AUTH_EMAIL_TAKEN",
          status: 409,
          message: "An account with this email already exists",
          fix: "Sign in with POST /auth/login instead, or use another email.",
        });
      }
      signIn(ctx as unknown as Context, user);
      return { user: publicUser(user) };
    },
  });

  const loginRoute = route.post(`${base}/login`, {
    name: "auth_login",
    summary: "Sign in with email and password",
    tags: ["auth"],
    mcp: false,
    body: t.object(Credentials),
    response: t.object({ user: UserSchema }),
    handler: async (ctx) => {
      await checkTurnstile(ctx as unknown as Context, ctx.body["cf-turnstile-response"]);
      const user = await users.findUserByEmail(ctx.body.email, ctx.env);
      if (!user) {
        // Same work as a real check, so response time does not reveal whether the email exists.
        dummyHash ??= hashPassword(randomId(), pw);
        await verifyPassword(ctx.body.password, await dummyHash, pw).catch(() => false);
        throw invalidLogin();
      }
      if (!(await verifyPassword(ctx.body.password, user.passwordHash, pw))) throw invalidLogin();
      if (needsRehash(user.passwordHash, pw)) {
        await users.updatePasswordHash(user.id, await hashPassword(ctx.body.password, pw), ctx.env);
      }
      signIn(ctx as unknown as Context, user);
      return { user: publicUser(user) };
    },
  });

  const logoutRoute = route.post(`${base}/logout`, {
    name: "auth_logout",
    summary: "Sign out and clear the session",
    tags: ["auth"],
    mcp: false,
    handler: (ctx) => {
      requireSession(ctx as unknown as Context).destroy();
    },
  });

  const meRoute = route.get(`${base}/me`, {
    name: "auth_me",
    summary: "Get the signed-in user",
    tags: ["auth"],
    auth: "required",
    response: t.object({ user: UserSchema }),
    handler: (ctx) => ({ user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, roles: ctx.user.roles } }),
  });

  const createTokenRoute = route.post(`${base}/tokens`, {
    name: "auth_create_token",
    summary: "Create an API token for the signed-in user (shown once)",
    tags: ["auth"],
    mcp: false,
    auth: "required",
    status: 201,
    body: t.object({ name: t.string({ minLength: 1, maxLength: 100 }), expiresInDays: t.optional(t.integer({ min: 1, max: 3650 })) }),
    response: t.object({ id: t.string(), name: t.string(), token: t.string(), expiresAt: t.nullable(t.number()) }),
    handler: async (ctx) => {
      const token = prefix + base64urlEncode(randomBytes(32));
      const id = randomId(12);
      const expiresAt = ctx.body.expiresInDays ? Date.now() + ctx.body.expiresInDays * 86_400_000 : null;
      await users.createToken({ id, userId: ctx.user.id, name: ctx.body.name, tokenHash: hex(await sha256(token)), createdAt: Date.now(), expiresAt }, ctx.env);
      return { id, name: ctx.body.name, token, expiresAt };
    },
  });

  const deleteTokenRoute = route.delete(`${base}/tokens/:id`, {
    name: "auth_delete_token",
    summary: "Revoke one of your API tokens",
    tags: ["auth"],
    auth: "required",
    params: t.object({ id: t.string({ maxLength: 100 }) }),
    handler: async (ctx) => {
      if (!(await users.deleteToken(ctx.params.id, ctx.user.id, ctx.env))) throw errors.notFound("API token", ctx.params.id);
    },
  });

  async function userFromToken(token: string, env: Env): Promise<StoredUser | null> {
    if (!token.startsWith(prefix) || token.length > 200) return null;
    const digest = hex(await sha256(token));
    const rec = await users.findTokenByHash(digest, env);
    // The lookup is by hash; compare again in constant time as defence in depth.
    if (!rec || !timingSafeEqual(utf8(rec.tokenHash), utf8(digest))) return null;
    if (rec.expiresAt !== null && rec.expiresAt <= Date.now()) return null;
    return users.findUserById(rec.userId, env);
  }

  return definePlugin({
    name: "auth",
    routes: [...(opts.register === false ? [] : [registerRoute]), loginRoute, logoutRoute, meRoute, createTokenRoute, deleteTokenRoute],
    setup(app) {
      const si = app.plugins.findIndex((p) => p.name === "session");
      const ai = app.plugins.findIndex((p) => p.name === "auth");
      if (si === -1 || si > ai) {
        throw errors.config("MIU_E_AUTH_SESSION_REQUIRED", "auth() needs session() earlier in plugins", "Use miu({ plugins: [session(), auth()] }).");
      }
    },
    async onRequest(ctx) {
      const header = ctx.headers.get("authorization");
      if (header && /^bearer\s/i.test(header)) {
        const user = await userFromToken(header.slice(7).trim(), ctx.env);
        if (!user) throw invalidToken();
        ctx.user = publicUser(user);
        ctx.state.authMethod = "token";
        return;
      }
      const userId = getSession(ctx)?.get<string>("userId");
      if (typeof userId === "string") {
        const user = await users.findUserById(userId, ctx.env);
        if (user) {
          ctx.user = publicUser(user);
          ctx.state.authMethod = "session";
        }
      }
    },
    inspect() {
      return {
        basePath: base,
        users: users.inspect?.() ?? { store: users.kind },
        password: { algorithm: pw.algorithm ?? "auto (argon2id on Bun, else pbkdf2)", iterations: pw.iterations },
        register: opts.register !== false,
        turnstile: opts.turnstile ? { enabled: true, secretKey: opts.turnstile.secretKey ? "(set)" : "env.TURNSTILE_SECRET_KEY" } : false,
      };
    },
    cloudflare(): CloudflareNeeds {
      return users.cloudflare?.() ?? {};
    },
  });
}
