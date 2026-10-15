// @miujs/auth — email/password accounts, sessions and API tokens. Sets `ctx.user`; core enforces
// `route.auth`. Needs `session()` earlier in `plugins`.

import { definePlugin, errors, processEnv, route, targetRuntime, t, type AuthUser, type CloudflareNeeds, type Context, type Env, type RouteDef } from "miujs";
import { getSession, hex, randomId, sha256, timingSafeEqual, utf8, base64urlEncode, randomBytes } from "@miujs/session";
import { defaultAuthEmails, type AuthEmails, type AuthMailer } from "./emails.ts";
import { DEFAULT_ITERATIONS, UNUSABLE_PASSWORD, WORKERS_FREE_CPU_MS, describePasswordHashing, hashPassword, needsRehash, pbkdf2WorkersCpuMs, suggestedWorkersCpuMs, verifyPassword, workersCpuWarning, type PasswordOptions } from "./password.ts";
import { authManage } from "./manage.ts";
import { RATE_LIMIT_DEFAULTS, memoryRateLimiter, type RateLimitOptions } from "./ratelimit.ts";
import { memoryUserStore, type OneTimeTokenPurpose, type OneTimeTokenRecord, type StoredUser, type UserStore } from "./store.ts";
import { OAUTH_STORE_METHODS, oauth as oauthRoutes, type OAuthOptions } from "./oauth.ts";
import { PASSKEY_STORE_METHODS, passkeys as passkeyRoutes, type PasskeyOptions } from "./passkeys.ts";

export * from "./emails.ts";
export * from "./password.ts";
export * from "./ratelimit.ts";
export * from "./cbor.ts";
export * from "./jose.ts";
export * from "./oauth.ts";
export * from "./passkeys.ts";
export * from "./store.ts";

export interface TurnstileOptions {
  /** Turnstile secret key. Default: `env.TURNSTILE_SECRET_KEY`. */
  secretKey?: string;
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * - `"off"` (default): today's behavior; no verify routes.
 * - `"optional"`: register signs in as before and emails a verify link; `ctx.user.emailVerified` says whether it was used.
 * - `"required"`: unverified users cannot sign in, and register always answers 202 "check-your-email" (no account enumeration).
 */
export type EmailVerificationMode = "off" | "optional" | "required";

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
  /**
   * Brute-force protection for login and register (on by default). Defaults: login 10 per
   * IP+account, 50 per account, 100 per IP per 15 min; register 10 per IP per hour.
   * `false` turns it off.
   */
  rateLimit?: RateLimitOptions | false;
  /**
   * Sends account emails (verify, reset). Default: `ctx.mail` from `mail()` in plugins.
   * Giving a mailer (or adding `mail()`) turns on POST /password/forgot, /password/reset and /password/change.
   */
  mailer?: AuthMailer;
  /**
   * Public URL that links in emails point to, e.g. `https://app.example.com`. Default: `env.APP_URL`;
   * in dev only, the request's origin. Required in production so a forged Host header cannot
   * redirect reset links to an attacker.
   */
  appUrl?: string;
  /** Default `"off"`. */
  emailVerification?: EmailVerificationMode;
  /** Replace the default email texts. */
  emails?: Partial<AuthEmails>;
  /** Pages in your app that emailed links open (they read `?token=` and POST it). */
  pages?: { verifyEmail?: string; resetPassword?: string; forgotPassword?: string };
  /**
   * Sign in with OAuth / OpenID Connect providers: `GET /auth/oauth/:provider` starts, the provider
   * returns to `/auth/oauth/:provider/callback`. Register `<appUrl>/auth/oauth/<id>/callback` as the
   * redirect URI at each provider.
   */
  oauth?: OAuthOptions;
  /** Sign in with passkeys (WebAuthn) under `/auth/passkeys`. */
  passkeys?: PasskeyOptions;
}

const MAX_PASSWORD = 1024;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HOUR = 3_600_000;
const VERIFY_TTL = 24 * HOUR;
const RESET_TTL = HOUR;
const CHECK_EMAIL = { status: "check-your-email" } as const;

const UserSchema = t.object({
  id: t.string(),
  email: t.optional(t.string()),
  name: t.optional(t.nullable(t.string())),
  roles: t.array(t.string()),
  emailVerified: t.optional(t.boolean()),
});

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

const ACCOUNT_STORE_METHODS = ["markEmailVerified", "changePassword", "createOneTimeToken", "consumeOneTimeToken", "deleteOneTimeTokens", "deleteUserTokens"] as const;

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
  // Runtime settings an operator can change (auth().manage()); start from the options.
  const live = { allowSignUps: true, minPasswordLength: opts.minPasswordLength ?? 8 };
  // Since this instance started; plain numbers, so memory stays constant.
  const counters = { signUps: 0, signIns: 0, failedSignIns: 0 };
  const prefix = opts.tokenPrefix ?? "miu_";
  const verification: EmailVerificationMode = opts.emailVerification ?? "off";
  const emails: AuthEmails = { ...defaultAuthEmails, ...opts.emails };
  const pages = { verifyEmail: "/verify-email", resetPassword: "/reset-password", forgotPassword: "/forgot-password", ...opts.pages };
  let dummyHash: Promise<string> | undefined;
  let dev = true;
  // Account emails (reset links) can be sent: a mailer was given, or setup found mail() in plugins.
  let mailOn = !!opts.mailer;

  const rl = opts.rateLimit === false ? null : (opts.rateLimit ?? {});
  const limiter = rl ? (rl.limiter ?? memoryRateLimiter()) : null;
  const loginLimits = { ...RATE_LIMIT_DEFAULTS.login, ...rl?.login };
  const registerLimits = { ...RATE_LIMIT_DEFAULTS.register, ...rl?.register };
  const resetLimits = { ...RATE_LIMIT_DEFAULTS.passwordReset, ...rl?.passwordReset };
  const verifyLimits = { ...RATE_LIMIT_DEFAULTS.verifyEmail, ...rl?.verifyEmail };

  function publicUser(u: StoredUser): AuthUser {
    const out: AuthUser = { id: u.id, email: u.email, name: u.name ?? undefined, roles: u.roles };
    if (verification !== "off") out.emailVerified = u.emailVerifiedAt != null;
    return out;
  }

  function clientIp(ctx: Context): string | undefined {
    if (rl?.trustProxyHeader) {
      const v = ctx.headers.get(rl.trustProxyHeader);
      // The rightmost entry is the one our trusted proxy appended; entries to its left come from the client.
      if (v) {
        const last = v.split(",").pop()!.trim();
        if (last) return last;
      }
    }
    return ctx.ip;
  }

  /** Counts one attempt against each rule; returns a 429 Response when any rule is exceeded. */
  async function limited(ctx: Context, rules: [key: string | null, limit: number][], windowSeconds: number): Promise<Response | null> {
    if (!limiter) return null;
    let retryAfter = 0;
    for (const [key, limit] of rules) {
      if (key === null) continue;
      const r = await limiter.hit(key, limit, windowSeconds, ctx.env);
      if (!r.ok) retryAfter = Math.max(retryAfter, r.retryAfter);
    }
    if (!retryAfter) return null;
    ctx.log.warn("auth rate limit hit", { route: ctx.route?.name, ip: clientIp(ctx) ?? null });
    return errors.tooManyRequests(retryAfter).toResponse({ "retry-after": String(retryAfter) });
  }

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
    if (password.length < live.minPasswordLength || password.length > MAX_PASSWORD) {
      throw errors.custom({
        code: "MIU_E_AUTH_PASSWORD_WEAK",
        status: 400,
        message: `Password must be ${live.minPasswordLength}–${MAX_PASSWORD} characters`,
        fix: `Choose a password of at least ${live.minPasswordLength} characters (a passphrase works well).`,
      });
    }
  }

  function signIn(ctx: Context, user: StoredUser) {
    if (user.disabledAt != null) throw accountDisabled();
    const s = requireSession(ctx);
    counters.signIns++;
    s.regenerate();
    s.set("userId", user.id);
    s.set("sv", user.sessionVersion ?? 0);
    ctx.user = publicUser(user);
  }

  // --- account emails ------------------------------------------------------------------------

  function mailerFor(ctx: Context): AuthMailer {
    const m = opts.mailer ?? (ctx as { mail?: AuthMailer }).mail;
    if (!m || typeof m.send !== "function") throw mailerMissing();
    return m;
  }

  /** Base URL for emailed links. Never derived from the Host header outside dev. */
  function appUrlFor(ctx: Context): string {
    const configured = opts.appUrl ?? (typeof ctx.env?.APP_URL === "string" ? (ctx.env.APP_URL as string) : undefined);
    if (configured) return configured.replace(/\/+$/, "");
    if (dev) return ctx.url.origin;
    throw appUrlMissing();
  }

  const store = users as Required<Pick<UserStore, (typeof ACCOUNT_STORE_METHODS)[number]>> & UserStore;

  async function issueToken(userId: string, purpose: OneTimeTokenPurpose, env: Env): Promise<string> {
    // One live link per purpose: a new one replaces any earlier one.
    await store.deleteOneTimeTokens(userId, purpose, env);
    const token = base64urlEncode(randomBytes(32));
    const now = Date.now();
    await store.createOneTimeToken({ tokenHash: hex(await sha256(token)), userId, purpose, createdAt: now, expiresAt: now + (purpose === "verify" ? VERIFY_TTL : RESET_TTL) }, env);
    return token;
  }

  /** Uses up a token. Returns its record only when it is genuine, of this purpose and unexpired. */
  async function consumeToken(token: string, purpose: OneTimeTokenPurpose, env: Env): Promise<OneTimeTokenRecord | null> {
    if (typeof token !== "string" || token.length < 32 || token.length > 200) return null;
    const digest = hex(await sha256(token));
    const rec = await store.consumeOneTimeToken(digest, purpose, env);
    if (!rec || !timingSafeEqual(utf8(rec.tokenHash), utf8(digest))) return null;
    if (rec.expiresAt <= Date.now()) return null;
    return rec;
  }

  const link = (appUrl: string, page: string, token?: string) => `${appUrl}${page}${token ? `?token=${token}` : ""}`;

  async function sendVerify(mailer: AuthMailer, appUrl: string, user: StoredUser, env: Env) {
    const token = await issueToken(user.id, "verify", env);
    await mailer.send({ to: user.email, ...emails.verifyEmail({ link: link(appUrl, pages.verifyEmail, token), appUrl }) });
  }

  /** Work whose duration must not show in the response time (it would reveal whether an account exists). */
  function inBackground(ctx: Context, task: () => Promise<unknown>) {
    ctx.waitUntil(Promise.resolve().then(task));
  }

  // --- routes ----------------------------------------------------------------------------------

  const Credentials = {
    email: t.string({ format: "email", maxLength: 254 }),
    password: t.string({ maxLength: MAX_PASSWORD }),
    "cf-turnstile-response": t.optional(t.string({ maxLength: 4096 })),
  };
  const Token = t.string({ maxLength: 200 });
  const StatusSchema = t.object({ status: t.string() });

  async function registerChecks(ctx: Context, body: { password: string; "cf-turnstile-response"?: string }): Promise<Response | null> {
    if (!live.allowSignUps) {
      throw errors.custom({
        code: "MIU_E_AUTH_SIGNUPS_CLOSED",
        status: 403,
        message: "Sign-ups are closed",
        fix: "New accounts cannot be created right now. Sign in with an existing account, or try again later.",
      });
    }
    const ip = clientIp(ctx);
    const blocked = await limited(ctx, [[ip ? `register:ip:${ip}` : null, registerLimits.perIp]], registerLimits.windowSeconds);
    if (blocked) return blocked;
    await checkTurnstile(ctx, body["cf-turnstile-response"]);
    checkPassword(body.password);
    return null;
  }

  const registerRoute =
    verification === "required"
      ? route.post(`${base}/register`, {
          name: "auth_register",
          summary: "Create an account with email and password; a link to confirm the email is sent",
          tags: ["auth", "csrf-always"],
          mcp: false,
          status: 202,
          body: t.object({ ...Credentials, name: t.optional(t.string({ maxLength: 200 })) }),
          response: StatusSchema,
          handler: async (ctx) => {
            const c = ctx as unknown as Context;
            const blocked = await registerChecks(c, ctx.body);
            if (blocked) return blocked;
            const mailer = mailerFor(c);
            const appUrl = appUrlFor(c);
            const passwordHash = await hashPassword(ctx.body.password, pw);
            const created = await users.createUser({ email: ctx.body.email, name: ctx.body.name ?? null, roles: [...(opts.defaultRoles ?? [])], passwordHash }, ctx.env);
            if (created) counters.signUps++;
            // Same answer either way, so the form cannot be used to test which emails have accounts.
            inBackground(c, async () => {
              if (created) return sendVerify(mailer, appUrl, created, ctx.env);
              const existing = await users.findUserByEmail(ctx.body.email, ctx.env);
              if (!existing) return;
              if (existing.emailVerifiedAt == null) return sendVerify(mailer, appUrl, existing, ctx.env);
              await mailer.send({ to: existing.email, ...emails.alreadyRegistered({ forgotPasswordLink: link(appUrl, pages.forgotPassword), appUrl }) });
            });
            return CHECK_EMAIL;
          },
        })
      : route.post(`${base}/register`, {
          name: "auth_register",
          summary: "Create an account with email and password, and sign in",
          tags: ["auth", "csrf-always"],
          mcp: false,
          status: 201,
          body: t.object({ ...Credentials, name: t.optional(t.string({ maxLength: 200 })) }),
          response: t.object({ user: UserSchema }),
          handler: async (ctx) => {
            const c = ctx as unknown as Context;
            const blocked = await registerChecks(c, ctx.body);
            if (blocked) return blocked;
            const mailer = verification === "optional" ? mailerFor(c) : null;
            const appUrl = mailer ? appUrlFor(c) : "";
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
            counters.signUps++;
            signIn(c, user);
            if (mailer) inBackground(c, () => sendVerify(mailer, appUrl, user, ctx.env));
            return { user: publicUser(user) };
          },
        });

  const loginRoute = route.post(`${base}/login`, {
    name: "auth_login",
    summary: "Sign in with email and password",
    tags: ["auth", "csrf-always"],
    mcp: false,
    body: t.object(Credentials),
    response: t.object({ user: UserSchema }),
    handler: async (ctx) => {
      const ip = clientIp(ctx as unknown as Context);
      const email = ctx.body.email.toLowerCase();
      const blocked = await limited(
        ctx as unknown as Context,
        [
          [`login:ip-account:${ip ?? "unknown"}:${email}`, loginLimits.perIpAccount],
          [`login:account:${email}`, loginLimits.perAccount],
          [ip ? `login:ip:${ip}` : null, loginLimits.perIp],
        ],
        loginLimits.windowSeconds,
      );
      if (blocked) return blocked;
      await checkTurnstile(ctx as unknown as Context, ctx.body["cf-turnstile-response"]);
      const user = await users.findUserByEmail(ctx.body.email, ctx.env);
      // Accounts without a password (made by OAuth) answer exactly like unknown emails.
      if (!user || user.passwordHash.startsWith(UNUSABLE_PASSWORD)) {
        // Same work as a real check, so response time does not reveal whether the email exists.
        dummyHash ??= hashPassword(randomId(), pw);
        await verifyPassword(ctx.body.password, await dummyHash, pw).catch(() => false);
        counters.failedSignIns++;
        throw invalidLogin();
      }
      if (!(await verifyPassword(ctx.body.password, user.passwordHash, pw))) {
        counters.failedSignIns++;
        throw invalidLogin();
      }
      if (needsRehash(user.passwordHash, pw)) {
        await users.updatePasswordHash(user.id, await hashPassword(ctx.body.password, pw), ctx.env);
      }
      // Only after the password matched, so this reveals nothing to someone without it.
      if (verification === "required" && user.emailVerifiedAt == null) throw emailUnverified(base);
      signIn(ctx as unknown as Context, user);
      return { user: publicUser(user) };
    },
  });

  const logoutRoute = route.post(`${base}/logout`, {
    name: "auth_logout",
    summary: "Sign out and clear the session",
    tags: ["auth", "csrf-always"],
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
    handler: (ctx) => {
      const user: Record<string, unknown> = { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, roles: ctx.user.roles };
      if (typeof ctx.user.emailVerified === "boolean") user.emailVerified = ctx.user.emailVerified;
      return { user: user as { id: string; roles: string[] } };
    },
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
      // A token that could mint tokens would survive its own revocation through its children.
      if (ctx.state.authMethod !== "session") {
        throw errors.custom({
          code: "MIU_E_AUTH_TOKEN_SESSION_REQUIRED",
          status: 403,
          message: "API tokens can only be created from a signed-in browser session",
          fix: "Sign in in the browser (not with an API token) and create the token there.",
        });
      }
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

  // --- verify / reset / change (added in setup when a mailer is available) --------------------

  const verifyRequestRoute = route.post(`${base}/verify-email/request`, {
    name: "auth_verify_email_request",
    summary: "Email a new link to confirm the address (signed in, or send { email })",
    tags: ["auth", "csrf-always"],
    mcp: false,
    auth: "optional",
    status: 202,
    body: t.object({ email: t.optional(t.string({ format: "email", maxLength: 254 })) }),
    response: StatusSchema,
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const ip = clientIp(c);
      const mailer = mailerFor(c);
      const appUrl = appUrlFor(c);
      if (ctx.user) {
        const blocked = await limited(c, [[`verify:account:${ctx.user.id}`, verifyLimits.perAccount], [ip ? `verify:ip:${ip}` : null, verifyLimits.perIp]], verifyLimits.windowSeconds);
        if (blocked) return blocked;
        const user = await users.findUserById(ctx.user.id, ctx.env);
        if (!user) throw errors.unauthorized();
        if (user.emailVerifiedAt != null) {
          ctx.set.status = 200;
          return { status: "already-verified" };
        }
        await sendVerify(mailer, appUrl, user, ctx.env);
        return CHECK_EMAIL;
      }
      const email = ctx.body.email;
      if (!email) throw errors.badRequest("Send { email } or sign in first", "POST { \"email\": \"you@example.com\" } to get a new link, or call this while signed in.");
      const blocked = await limited(c, [[`verify:account:${email.toLowerCase()}`, verifyLimits.perAccount], [ip ? `verify:ip:${ip}` : null, verifyLimits.perIp]], verifyLimits.windowSeconds);
      if (blocked) return blocked;
      inBackground(c, async () => {
        const user = await users.findUserByEmail(email, ctx.env);
        if (user && user.emailVerifiedAt == null) await sendVerify(mailer, appUrl, user, ctx.env);
      });
      return CHECK_EMAIL;
    },
  });

  const verifyRoute = route.post(`${base}/verify-email`, {
    name: "auth_verify_email",
    summary: "Confirm an email address with the token from the emailed link",
    tags: ["auth", "csrf-always"],
    mcp: false,
    body: t.object({ token: Token }),
    response: StatusSchema,
    handler: async (ctx) => {
      const rec = await consumeToken(ctx.body.token, "verify", ctx.env);
      if (!rec) {
        throw errors.custom({
          code: "MIU_E_AUTH_VERIFY_INVALID",
          status: 400,
          message: "This email confirmation link is invalid, used or expired",
          fix: `Request a new link with POST ${base}/verify-email/request. Links work once and expire after 24 hours.`,
        });
      }
      await store.markEmailVerified(rec.userId, Date.now(), ctx.env);
      return { status: "verified" };
    },
  });

  const forgotRoute = route.post(`${base}/password/forgot`, {
    name: "auth_password_forgot",
    summary: "Email a password reset link (same answer whether or not the account exists)",
    tags: ["auth", "csrf-always"],
    mcp: false,
    status: 202,
    body: t.object({ email: t.string({ format: "email", maxLength: 254 }) }),
    response: StatusSchema,
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const ip = clientIp(c);
      const email = ctx.body.email.toLowerCase();
      const blocked = await limited(c, [[`reset:account:${email}`, resetLimits.perAccount], [ip ? `reset:ip:${ip}` : null, resetLimits.perIp]], resetLimits.windowSeconds);
      if (blocked) return blocked;
      const mailer = mailerFor(c);
      const appUrl = appUrlFor(c);
      inBackground(c, async () => {
        const user = await users.findUserByEmail(email, ctx.env);
        // Disabled accounts get nothing: a reset must not become a way back in.
        if (!user || user.disabledAt != null) return;
        const token = await issueToken(user.id, "reset", ctx.env);
        await mailer.send({ to: user.email, ...emails.resetPassword({ link: link(appUrl, pages.resetPassword, token), appUrl }) });
      });
      return CHECK_EMAIL;
    },
  });

  const resetRoute = route.post(`${base}/password/reset`, {
    name: "auth_password_reset",
    summary: "Set a new password with the token from the emailed link, and sign in",
    tags: ["auth", "csrf-always"],
    mcp: false,
    body: t.object({ token: Token, password: t.string({ maxLength: MAX_PASSWORD }) }),
    response: t.object({ user: UserSchema }),
    handler: async (ctx) => {
      // Before using up the token, so a weak password can be retried with the same link.
      checkPassword(ctx.body.password);
      const rec = await consumeToken(ctx.body.token, "reset", ctx.env);
      const found = rec ? await users.findUserById(rec.userId, ctx.env) : null;
      // A link issued before the account was disabled is as dead as an expired one.
      const user = found && found.disabledAt == null ? found : null;
      if (!user) {
        throw errors.custom({
          code: "MIU_E_AUTH_RESET_INVALID",
          status: 400,
          message: "This password reset link is invalid, used or expired",
          fix: `Ask for a new link with POST ${base}/password/forgot. Links work once and expire after 1 hour.`,
        });
      }
      const passwordHash = await hashPassword(ctx.body.password, pw);
      const sessionVersion = await store.changePassword(user.id, passwordHash, ctx.env);
      await store.deleteOneTimeTokens(user.id, "reset", ctx.env);
      // A reset means the account may have been taken over: API tokens an attacker made must stop working.
      // (A normal change, made with the current password, keeps them.)
      await store.deleteUserTokens(user.id, ctx.env);
      // ...and so must sign-in methods they could have added with a stolen session: passkeys and
      // linked providers. The owner adds their own again after signing in with the new password.
      await users.deleteUserPasskeys?.(user.id, ctx.env);
      if (users.listOAuthAccounts && users.deleteOAuthAccount) {
        for (const a of await users.listOAuthAccounts(user.id, ctx.env)) await users.deleteOAuthAccount(user.id, a.provider, ctx.env);
      }
      // Opening the emailed link proves the address belongs to them.
      const emailVerifiedAt = user.emailVerifiedAt ?? Date.now();
      if (user.emailVerifiedAt == null) await store.markEmailVerified(user.id, emailVerifiedAt, ctx.env);
      const updated: StoredUser = { ...user, passwordHash, sessionVersion, emailVerifiedAt };
      signIn(ctx as unknown as Context, updated);
      return { user: publicUser(updated) };
    },
  });

  const changeRoute = route.post(`${base}/password/change`, {
    name: "auth_password_change",
    summary: "Change your password; other sessions are signed out",
    tags: ["auth", "csrf-always"],
    mcp: false,
    auth: "required",
    body: t.object({ currentPassword: t.string({ maxLength: MAX_PASSWORD }), newPassword: t.string({ maxLength: MAX_PASSWORD }) }),
    response: StatusSchema,
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const blocked = await limited(c, [[`change:user:${ctx.user.id}`, loginLimits.perIpAccount]], loginLimits.windowSeconds);
      if (blocked) return blocked;
      checkPassword(ctx.body.newPassword);
      const user = await users.findUserById(ctx.user.id, ctx.env);
      if (!user) throw errors.unauthorized();
      if (!(await verifyPassword(ctx.body.currentPassword, user.passwordHash, pw))) {
        throw errors.custom({
          code: "MIU_E_AUTH_PASSWORD_INCORRECT",
          status: 403,
          message: "The current password is incorrect",
          fix: `Send your current password as currentPassword. Forgot it? Use POST ${base}/password/forgot.`,
        });
      }
      const passwordHash = await hashPassword(ctx.body.newPassword, pw);
      const sessionVersion = await store.changePassword(user.id, passwordHash, ctx.env);
      await store.deleteOneTimeTokens(user.id, "reset", ctx.env);
      // Keep this browser signed in under the new version; every other session is now stale.
      if (ctx.state.authMethod === "session") signIn(c, { ...user, passwordHash, sessionVersion });
      return { status: "password-changed" };
    },
  });

  const accountRoutes: RouteDef[] = [...(verification === "off" ? [] : [verifyRequestRoute, verifyRoute]), forgotRoute, resetRoute, changeRoute];

  // --- OAuth / OpenID Connect ------------------------------------------------------------------

  const oauth = opts.oauth
    ? oauthRoutes(opts.oauth, {
        base,
        users,
        defaultRoles: opts.defaultRoles ?? [],
        verification,
        isDev: () => dev,
        appUrlFor,
        signIn,
        allowSignUps: () => live.allowSignUps,
      })
    : null;

  const passkeys = opts.passkeys
    ? passkeyRoutes(opts.passkeys, {
        base,
        users,
        verification,
        signIn,
        publicUser,
        emailUnverified: () => emailUnverified(base),
        limit: (ctx) => {
          const ip = clientIp(ctx);
          return limited(ctx, [[ip ? `passkey:ip:${ip}` : null, loginLimits.perIp]], loginLimits.windowSeconds);
        },
      })
    : null;

  function requireStoreMethods(methods: readonly string[], feature: string) {
    const missing = methods.filter((m) => typeof (users as unknown as Record<string, unknown>)[m] !== "function");
    if (missing.length) {
      throw errors.config(
        "MIU_E_AUTH_STORE_UNSUPPORTED",
        `The ${users.kind} user store lacks ${missing.join(", ")}, needed for ${feature}`,
        "Use memoryUserStore() or dbUserStore(db), or implement those UserStore methods in your store.",
      );
    }
  }

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
    routes: [...(opts.register === false ? [] : [registerRoute]), loginRoute, logoutRoute, meRoute, createTokenRoute, deleteTokenRoute, ...(oauth?.routes ?? []), ...(passkeys?.routes ?? [])],
    setup(app) {
      const si = app.plugins.findIndex((p) => p.name === "session");
      const ai = app.plugins.findIndex((p) => p.name === "auth");
      if (si === -1 || si > ai) {
        throw errors.config("MIU_E_AUTH_SESSION_REQUIRED", "auth() needs session() earlier in plugins", "Use miu({ plugins: [session(), auth()] }).");
      }
      dev = app.dev;
      // PBKDF2 can need far more CPU than a Workers plan allows: say so once, never weaken it silently.
      if (targetRuntime() === "workerd") {
        const cpu = workersCpuWarning(pw);
        if (cpu) app.log.warn(cpu);
      }
      if (opts.appUrl !== undefined && !/^https?:\/\/[^\s/]+/i.test(opts.appUrl)) {
        throw errors.config("MIU_E_AUTH_APP_URL_INVALID", `appUrl ${JSON.stringify(opts.appUrl)} is not an http(s) URL`, 'Pass auth({ appUrl: "https://app.example.com" }).');
      }
      if (oauth) {
        oauth.validate();
        requireStoreMethods(OAUTH_STORE_METHODS, "OAuth sign-in");
        // redirect_uri is built from appUrl; never from the Host header outside dev.
        if (!dev && !opts.appUrl && app.runtime !== "workerd" && !processEnv().APP_URL) throw appUrlMissing();
      }
      if (passkeys) {
        passkeys.validate();
        requireStoreMethods(PASSKEY_STORE_METHODS, "passkeys");
      }
      const hasMail = app.plugins.some((p) => p.name === "mail");
      if (!opts.mailer && !hasMail && verification === "off") return;
      if (!opts.mailer && !hasMail) throw mailerMissing();
      requireStoreMethods(ACCOUNT_STORE_METHODS, "email verification and password reset");
      // On Workers env arrives per request, so APP_URL is checked when the first link is built.
      if (!dev && !opts.appUrl && app.runtime !== "workerd" && !processEnv().APP_URL) throw appUrlMissing();
      app.add(accountRoutes);
      mailOn = true;
    },
    async onRequest(ctx) {
      const header = ctx.headers.get("authorization");
      if (header && /^bearer\s/i.test(header)) {
        const user = await userFromToken(header.slice(7).trim(), ctx.env);
        if (!user || user.disabledAt != null) throw invalidToken();
        ctx.user = publicUser(user);
        ctx.state.authMethod = "token";
        return;
      }
      const s = getSession(ctx);
      const userId = s?.get<string>("userId");
      if (typeof userId === "string") {
        const user = await users.findUserById(userId, ctx.env);
        // A password reset/change bumps sessionVersion, which signs out sessions from before it.
        const current = user && (s!.get<number>("sv") ?? 0) === (user.sessionVersion ?? 0);
        if (user && current && user.disabledAt == null && !(verification === "required" && user.emailVerifiedAt == null)) {
          ctx.user = publicUser(user);
          ctx.state.authMethod = "session";
        }
      }
    },
    manage() {
      return authManage({
        users,
        live,
        counters,
        loginLimits,
        rateLimited: !!limiter,
        register: opts.register !== false,
        passwordHashing: describePasswordHashing(pw),
        verification,
        oauthProviders: oauth?.providers ?? [],
        passkeys: !!passkeys,
        maxPasswordLength: MAX_PASSWORD,
        canMail: () => mailOn,
        async sendReset(ctx, user) {
          const mailer = mailerFor(ctx);
          const appUrl = appUrlFor(ctx);
          const token = await issueToken(user.id, "reset", ctx.env);
          await mailer.send({ to: user.email, ...emails.resetPassword({ link: link(appUrl, pages.resetPassword, token), appUrl }) });
        },
      });
    },
    inspect() {
      return {
        basePath: base,
        users: users.inspect?.() ?? { store: users.kind },
        password: { algorithm: pw.algorithm ?? "auto (argon2id on Bun, else pbkdf2)", iterations: pw.iterations },
        register: opts.register !== false,
        turnstile: opts.turnstile ? { enabled: true, secretKey: opts.turnstile.secretKey ? "(set)" : "env.TURNSTILE_SECRET_KEY" } : false,
        rateLimit: limiter
          ? { limiter: limiter.kind, login: loginLimits, register: registerLimits, passwordReset: resetLimits, verifyEmail: verifyLimits, ipFrom: rl?.trustProxyHeader ?? "ctx.ip" }
          : false,
        emailVerification: verification,
        mailer: opts.mailer ? "custom" : "ctx.mail (when mail() is in plugins)",
        appUrl: opts.appUrl ?? "env.APP_URL (request origin in dev)",
        oauth: oauth ? oauth.inspect() : false,
        passkeys: passkeys ? passkeys.inspect() : false,
      };
    },
    cloudflare(): CloudflareNeeds {
      const needs: CloudflareNeeds = { ...users.cloudflare?.() };
      // The binding applies one limit to every key, so size it for the strictest login rule.
      if (limiter?.binding) needs.ratelimits = [{ binding: limiter.binding, limit: loginLimits.perIpAccount, period: 60 }];
      // PBKDF2 (Workers has no argon2id) over the Free plan's CPU limit: ask for a cpu_ms that fits.
      const iterations = pw.iterations ?? DEFAULT_ITERATIONS;
      if (pw.algorithm !== "argon2id" && pbkdf2WorkersCpuMs(iterations) > WORKERS_FREE_CPU_MS) {
        needs.limits = { cpuMs: Math.max(suggestedWorkersCpuMs(iterations), typeof pw.workersCpuMs === "number" ? pw.workersCpuMs : 0) };
      }
      return needs;
    },
  });
}

function mailerMissing() {
  return errors.config(
    "MIU_E_AUTH_MAILER_MISSING",
    "Email verification and password reset need a way to send email",
    "Add mail({ transport, from }) from @miujs/mail to plugins, or pass auth({ mailer: { send } }).",
  );
}

function appUrlMissing() {
  return errors.config(
    "MIU_E_AUTH_APP_URL_MISSING",
    "No public app URL for links in account emails",
    'Pass auth({ appUrl: "https://your-app.example" }) or set the APP_URL env var. Links are never built from the Host header in production (it can be forged).',
  );
}

function emailUnverified(base: string) {
  return errors.custom({
    code: "MIU_E_AUTH_EMAIL_UNVERIFIED",
    status: 403,
    message: "Confirm your email address before signing in",
    fix: `Open the link in the confirmation email we sent. To get a new one, POST { "email" } to ${base}/verify-email/request.`,
  });
}

function accountDisabled() {
  return errors.custom({
    code: "MIU_E_AUTH_ACCOUNT_DISABLED",
    status: 403,
    message: "This account has been disabled",
    fix: "Contact the site's administrators to have it enabled again.",
  });
}
