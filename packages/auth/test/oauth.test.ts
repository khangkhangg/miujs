// OAuth 2.0 / OpenID Connect sign-in.
import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { base64urlEncode, session, sign, utf8 } from "@miujs/session";
import { sqlite } from "@miujs/db";
import { auth, dbUserStore, memoryUserStore, verifyJws, type AuthOptions, type OAuthOptions, type UserStore } from "../src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";
import { fakeDiscord, fakeFetch, fakeGithub, fakeOidc, s256 } from "./oauth-fakes.ts";

const BASE = "http://localhost";
const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };
const APP_URL = "https://app.example";
const PW = "correct horse battery";
const STATE_SECRET = "oauth-state-secret-that-is-long-enough-123";
const ISSUER = "https://idp.example";

async function setup(opts: { auth?: Partial<AuthOptions>; oauth?: Partial<OAuthOptions>; users?: UserStore; dev?: boolean; alg?: "RS256" | "ES256" } = {}) {
  const idp = await fakeOidc({ issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret", alg: opts.alg });
  const google = await fakeOidc({ issuer: "https://accounts.google.com", clientId: "g-client", clientSecret: "g-secret" });
  const github = fakeGithub({ clientId: "gh-client", clientSecret: "gh-secret" });
  const discord = fakeDiscord({ clientId: "dc-client", clientSecret: "dc-secret" });
  const net = fakeFetch(idp.handle, google.handle, github.handle, discord.handle);
  const users = opts.users ?? memoryUserStore();
  const app = miu({
    logLevel: "silent",
    mcp: true,
    dev: opts.dev,
    plugins: [
      session({ secret: SECRET }),
      auth({
        users,
        password: FAST,
        appUrl: APP_URL,
        oauth: {
          fetch: net.fetch,
          secret: STATE_SECRET,
          google: { clientId: "g-client", clientSecret: "g-secret" },
          github: { clientId: "gh-client", clientSecret: "gh-secret" },
          discord: { clientId: "dc-client", clientSecret: "dc-secret" },
          oidc: [{ id: "idp", issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret", scopes: ["openid", "email", "profile"] }],
          ...opts.oauth,
        },
        ...opts.auth,
      }),
    ],
  });
  return { app, users, idp, google, github, discord, net };
}
type S = Awaited<ReturnType<typeof setup>>;

async function start(s: S, jar: Jar, provider: string, returnTo?: string) {
  const res = await s.app.fetch(jar.request(`${BASE}/auth/oauth/${provider}${returnTo !== undefined ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`));
  jar.store(res);
  return res;
}

async function callback(s: S, jar: Jar, provider: string, params: Record<string, string>) {
  const res = await s.app.fetch(jar.request(`${BASE}/auth/oauth/${provider}/callback?${new URLSearchParams(params)}`));
  jar.store(res);
  return res;
}

/** Full browser round trip through the fake IdP. */
async function signInWith(s: S, claims: Record<string, unknown>, opts: { jar?: Jar; provider?: string; returnTo?: string } = {}) {
  const jar = opts.jar ?? new Jar();
  const provider = opts.provider ?? "idp";
  const st = await start(s, jar, provider, opts.returnTo);
  expect(st.status).toBe(302);
  const url = new URL(st.headers.get("location")!);
  const idp = provider === "google" ? s.google : s.idp;
  const code = idp.authorize(url, claims);
  const res = await callback(s, jar, provider, { code, state: url.searchParams.get("state")! });
  return { res, jar, url };
}

const me = async (s: S, jar: Jar) => {
  const r = await s.app.fetch(jar.request(`${BASE}/auth/me`));
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as { user: Record<string, unknown> }).user : null };
};
const post = (jar: Jar, path: string, body: unknown) => jar.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function send(s: S, jar: Jar, path: string, body: unknown) {
  const r = await s.app.fetch(post(jar, path, body));
  jar.store(r);
  return r;
}
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string; fix?: string } }).error;
const ANN = { sub: "ann-1", email: "ann@example.com", email_verified: true, name: "Ann" };

// ---------------------------------------------------------------------------------------------

describe("wiring", () => {
  test("routes exist only when oauth is configured; none are MCP tools", async () => {
    const plain = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST })] });
    await plain.ready();
    expect(plain.routes().some((r) => r.path.includes("oauth"))).toBe(false);
    const s = await setup();
    await s.app.ready();
    const info = s.app.inspect();
    const oauth = info.routes.filter((r) => r.path.includes("/oauth/"));
    expect(oauth.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "DELETE /auth/oauth/accounts/:provider",
      "GET /auth/oauth/:provider",
      "GET /auth/oauth/:provider/callback",
      "GET /auth/oauth/accounts",
    ]);
    for (const r of oauth) expect(info.mcp!.tools.some((t) => t.includes(r.name))).toBe(false);
  });

  test("with a form_post provider (Apple) a POST callback exists, tagged csrf-exempt (state + signed cookie protect it)", async () => {
    const s = await setup({ oauth: { apple: await appleConfig() } });
    await s.app.ready();
    const cb = s.app.inspect().routes.find((r) => r.method === "POST" && r.path === "/auth/oauth/:provider/callback")!;
    expect(cb).toBeTruthy();
    expect(cb.tags).toContain("csrf-exempt");
  });

  test("unknown provider → 404 MIU_E_AUTH_OAUTH_PROVIDER_UNKNOWN with a fix", async () => {
    const s = await setup();
    const res = await start(s, new Jar(), "myspace");
    expect(res.status).toBe(404);
    const e = await errCode(res);
    expect(e.code).toBe("MIU_E_AUTH_OAUTH_PROVIDER_UNKNOWN");
    expect(e.fix).toContain("idp");
  });

  test("bad config is a startup error with a fix", async () => {
    for (const oauth of [
      { oidc: [{ id: "Bad Id!", issuer: ISSUER, clientId: "c", clientSecret: "s" }] },
      { oidc: [{ id: "x", issuer: "http://insecure.example", clientId: "c", clientSecret: "s" }] },
      { oidc: [{ id: "google", issuer: ISSUER, clientId: "c", clientSecret: "s" }], google: { clientId: "c", clientSecret: "s" } },
      { github: { clientId: "", clientSecret: "s" } },
    ] as OAuthOptions[]) {
      const app = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST, oauth })] });
      const err = await app.ready().catch((e) => e);
      expect(err?.code).toBe("MIU_E_AUTH_OAUTH_CONFIG");
      expect(err.fix).toBeTruthy();
    }
  });

  test("a store without OAuth methods is a startup error", async () => {
    const base = memoryUserStore();
    const legacy: UserStore = { ...base, findOAuthAccount: undefined, createOAuthAccount: undefined };
    const s = await setup({ users: legacy });
    const err = await s.app.ready().catch((e) => e);
    expect(err?.code).toBe("MIU_E_AUTH_STORE_UNSUPPORTED");
  });

  test("production without appUrl is a startup error (redirect_uri must not come from Host)", async () => {
    const s = await setup({ dev: false, auth: { appUrl: undefined } });
    const err = await s.app.ready().catch((e) => e);
    expect(err?.code).toBe("MIU_E_AUTH_APP_URL_MISSING");
  });

  test("production without any state secret fails with a fix", async () => {
    const s = await setup({ dev: false, oauth: { secret: undefined } });
    const res = await start(s, new Jar(), "idp");
    expect(res.status).toBe(500);
    const e = await errCode(res);
    expect(e.code).toBe("MIU_E_AUTH_OAUTH_STATE_SECRET_MISSING");
    expect(e.fix).toContain("SESSION_SECRET");
  });
});

// ---------------------------------------------------------------------------------------------

describe("start", () => {
  test("redirects to the provider with code + PKCE S256 + state + nonce, and sets a short-lived signed HttpOnly cookie", async () => {
    const s = await setup();
    const jar = new Jar();
    const res = await start(s, jar, "idp");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("idp-client");
    expect(p.get("redirect_uri")).toBe(`${APP_URL}/auth/oauth/idp/callback`);
    expect(p.get("scope")).toBe("openid email profile");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(32);
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(32);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("miu_oauth="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/auth\/oauth/);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)![1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("each start uses a fresh state, verifier and nonce", async () => {
    const s = await setup();
    const a = new URL((await start(s, new Jar(), "idp")).headers.get("location")!).searchParams;
    const b = new URL((await start(s, new Jar(), "idp")).headers.get("location")!).searchParams;
    for (const k of ["state", "nonce", "code_challenge"]) expect(a.get(k)).not.toBe(b.get(k));
  });

  test("returnTo must be a same-origin relative path", async () => {
    const s = await setup();
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "evil", "/ok\r\nSet-Cookie: x=1", "/%0d%0a", "/" + "a".repeat(3000)]) {
      const res = await start(s, new Jar(), "idp", bad);
      expect([bad, res.status]).toEqual([bad, 400]);
      expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_RETURN_TO");
    }
    expect((await start(s, new Jar(), "idp", "/dashboard?tab=1#top")).status).toBe(302);
  });
});

// ---------------------------------------------------------------------------------------------

describe("callback: sign-in and accounts", () => {
  test("first sign-in creates a verified user, signs in, clears the state cookie and redirects to returnTo", async () => {
    const s = await setup({ auth: { emailVerification: "optional", mailer: { send: async () => {} } } });
    const { res, jar } = await signInWith(s, ANN, { returnTo: "/welcome?x=1" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/welcome?x=1");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("miu_oauth=") && /Max-Age=0/i.test(c))).toBe(true);
    const m = await me(s, jar);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ email: "ann@example.com", name: "Ann", emailVerified: true });
    const u = (await s.users.findUserByEmail("ann@example.com", {}))!;
    expect(u.emailVerifiedAt).not.toBeNull();
    expect(await s.users.findOAuthAccount!("idp", "ann-1", {})).toMatchObject({ userId: u.id });
  });

  test("without returnTo it redirects to /", async () => {
    const s = await setup();
    const { res } = await signInWith(s, ANN);
    expect(res.headers.get("location")).toBe("/");
  });

  test("the same provider identity signs in to the same user again", async () => {
    const s = await setup();
    await signInWith(s, ANN);
    const { jar } = await signInWith(s, { ...ANN, email: "changed@example.com" });
    expect((await me(s, jar)).body!.email).toBe("ann@example.com");
  });

  test("sign-in regenerates the session id (no fixation)", async () => {
    const s = await setup();
    const jar = new Jar();
    const r = await s.app.fetch(jar.request(`${BASE}/auth/me`));
    jar.store(r);
    await send(s, jar, "/auth/login", { email: "x@example.com", password: "nope-nope" });
    const before = jar.cookies.get("miu_session");
    await signInWith(s, ANN, { jar });
    expect(jar.cookies.get("miu_session")).toBeTruthy();
    expect(jar.cookies.get("miu_session")).not.toBe(before);
  });

  test("a verified provider email links to the existing verified account", async () => {
    const s = await setup();
    const reg = new Jar();
    await send(s, reg, "/auth/register", { email: "ann@example.com", password: PW });
    const u = (await s.users.findUserByEmail("ann@example.com", {}))!;
    await s.users.markEmailVerified!(u.id, Date.now(), {});
    const { jar } = await signInWith(s, ANN);
    expect((await me(s, jar)).body!.id).toBe(u.id);
    // The password still works and the other session is untouched.
    expect((await send(s, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(200);
    expect((await me(s, reg)).status).toBe(200);
  });

  test("NEVER links on an unverified provider email: a separate user is created and the existing account is untouched", async () => {
    const s = await setup();
    const reg = new Jar();
    await send(s, reg, "/auth/register", { email: "ann@example.com", password: PW });
    const victim = (await s.users.findUserByEmail("ann@example.com", {}))!;
    for (const [i, claims] of [
      { sub: "att-1", email: "ann@example.com", email_verified: false },
      { sub: "att-2", email: "ann@example.com" },
      { sub: "att-3", email: "ann@example.com", email_verified: "false" },
      { sub: "att-4", email: "ANN@example.com", email_verified: 1 },
    ].entries()) {
      const { res, jar } = await signInWith(s, claims);
      expect([i, res.status]).toEqual([i, 302]);
      const who = (await me(s, jar)).body!;
      expect(who.id).not.toBe(victim.id);
      expect(who.email).not.toBe("ann@example.com");
      expect(String(who.email)).toMatch(/@oauth\.invalid$/);
    }
    expect((await s.users.findOAuthAccount!("idp", "att-1", {}))!.userId).not.toBe(victim.id);
    expect((await send(s, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(200);
    expect((await me(s, reg)).status).toBe(200);
  });

  test("an unverified provider email does not claim the address for later sign-ups", async () => {
    const s = await setup();
    await signInWith(s, { sub: "att-1", email: "bob@example.com", email_verified: false });
    expect(await s.users.findUserByEmail("bob@example.com", {})).toBeNull();
    expect((await send(s, new Jar(), "/auth/register", { email: "bob@example.com", password: PW })).status).toBe(201);
  });

  test("email_verified as the string \"true\" (Apple) counts as verified", async () => {
    const s = await setup();
    const { jar } = await signInWith(s, { sub: "s", email: "cat@example.com", email_verified: "true" });
    expect((await me(s, jar)).body!.email).toBe("cat@example.com");
  });

  test("an existing account whose email is NOT verified is never auto-linked (pre-hijack): 409 MIU_E_AUTH_OAUTH_ACCOUNT_EXISTS, nothing wiped", async () => {
    const s = await setup();
    // Someone (maybe an attacker squatting the address) registered first; verification is "off".
    const owner = new Jar();
    await send(s, owner, "/auth/register", { email: "ann@example.com", password: PW });
    const token = (await (await send(s, owner, "/auth/tokens", { name: "persist" })).json()).token as string;
    const user = (await s.users.findUserByEmail("ann@example.com", {}))!;
    expect(user.emailVerifiedAt).toBeNull();
    const { res, jar } = await signInWith(s, ANN);
    expect(res.status).toBe(409);
    const e = await errCode(res);
    expect(e.code).toBe("MIU_E_AUTH_OAUTH_ACCOUNT_EXISTS");
    expect(e.fix).toBe("An account with this email already exists. Sign in with your password, then link idp from your account settings.");
    expect((await me(s, jar)).status).toBe(401);
    expect(await s.users.findOAuthAccount!("idp", "ann-1", {})).toBeNull();
    // Nothing about the existing account changed.
    const after = (await s.users.findUserById(user.id, {}))!;
    expect(after).toEqual(user);
    expect((await me(s, owner)).status).toBe(200);
    expect((await send(s, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(200);
    const viaToken = await s.app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
    expect(viaToken.status).toBe(200);
  });

  test("auto-linking to a verified account never touches its password, sessions or tokens", async () => {
    const s = await setup();
    const owner = new Jar();
    await send(s, owner, "/auth/register", { email: "ann@example.com", password: PW });
    const token = (await (await send(s, owner, "/auth/tokens", { name: "t" })).json()).token as string;
    const user = (await s.users.findUserByEmail("ann@example.com", {}))!;
    await s.users.markEmailVerified!(user.id, 123, {});
    const before = (await s.users.findUserById(user.id, {}))!;
    const { res } = await signInWith(s, ANN);
    expect(res.status).toBe(302);
    expect(await s.users.findUserById(user.id, {})).toEqual(before);
    expect((await me(s, owner)).status).toBe(200);
    expect((await s.app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
  });

  test("emailVerification: required refuses an unverified provider email (403) and creates nobody", async () => {
    const s = await setup({ auth: { emailVerification: "required", mailer: { send: async () => {} } } });
    const { res } = await signInWith(s, { sub: "u", email: "dan@example.com", email_verified: false });
    expect(res.status).toBe(403);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_EMAIL_UNVERIFIED");
    expect(await s.users.findOAuthAccount!("idp", "u", {})).toBeNull();
    const ok = await signInWith(s, { sub: "v", email: "eve@example.com", email_verified: true });
    expect(ok.res.status).toBe(302);
    expect((await me(s, ok.jar)).body!.emailVerified).toBe(true);
  });

  test("an OAuth-only account cannot sign in with a password (plain 401, not 500)", async () => {
    const s = await setup();
    await signInWith(s, ANN);
    for (const password of ["", "!", "anything at all"]) {
      const r = await send(s, new Jar(), "/auth/login", { email: "ann@example.com", password });
      expect(r.status).toBe(401);
      expect((await errCode(r)).code).toBe("MIU_E_AUTH_INVALID");
    }
  });

  test("works end to end with dbUserStore", async () => {
    const s = await setup({ users: dbUserStore(sqlite()) });
    const { jar } = await signInWith(s, ANN);
    expect((await me(s, jar)).body!.email).toBe("ann@example.com");
    const again = await signInWith(s, ANN);
    expect((await me(s, again.jar)).body!.id).toBe((await me(s, jar)).body!.id);
  });

  test("Google: discovery + JWKS from accounts.google.com, both issuer spellings accepted", async () => {
    const s = await setup();
    const a = await signInWith(s, { sub: "g1", email: "g@example.com", email_verified: true }, { provider: "google" });
    expect(a.url.origin).toBe("https://accounts.google.com");
    expect((await me(s, a.jar)).body!.email).toBe("g@example.com");
    s.google.state.next = { claims: { iss: "accounts.google.com" } };
    const b = await signInWith(s, { sub: "g1", email: "g@example.com", email_verified: true }, { provider: "google" });
    expect(b.res.status).toBe(302);
  });

  test("ES256-signed id_tokens verify too", async () => {
    const s = await setup({ alg: "ES256" });
    const { res } = await signInWith(s, ANN);
    expect(res.status).toBe(302);
  });
});

// ---------------------------------------------------------------------------------------------

describe("callback: rejected", () => {
  async function noUser(s: S) {
    expect(await s.users.findUserByEmail("ann@example.com", {})).toBeNull();
    expect(await s.users.findOAuthAccount!("idp", "ann-1", {})).toBeNull();
  }

  test("no state cookie → 400 MIU_E_AUTH_OAUTH_STATE", async () => {
    const s = await setup();
    const st = await start(s, new Jar(), "idp");
    const url = new URL(st.headers.get("location")!);
    const code = s.idp.authorize(url, ANN);
    const res = await callback(s, new Jar(), "idp", { code, state: url.searchParams.get("state")! });
    expect(res.status).toBe(400);
    const e = await errCode(res);
    expect(e.code).toBe("MIU_E_AUTH_OAUTH_STATE");
    expect(e.fix).toBeTruthy();
    await noUser(s);
  });

  test("state that does not match the cookie (login CSRF) → 400", async () => {
    const s = await setup();
    const victim = new Jar();
    await start(s, victim, "idp");
    // The attacker's own authorization, replayed into the victim's browser.
    const atk = await start(s, new Jar(), "idp");
    const url = new URL(atk.headers.get("location")!);
    const code = s.idp.authorize(url, { sub: "attacker", email: "a@evil.example", email_verified: true });
    const res = await callback(s, victim, "idp", { code, state: url.searchParams.get("state")! });
    expect(res.status).toBe(400);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_STATE");
    expect((await me(s, victim)).status).toBe(401);
  });

  test("missing state parameter → 400", async () => {
    const s = await setup();
    const jar = new Jar();
    const url = new URL((await start(s, jar, "idp")).headers.get("location")!);
    const res = await callback(s, jar, "idp", { code: s.idp.authorize(url, ANN) });
    expect(res.status).toBe(400);
  });

  test("a tampered, expired or other-provider state cookie → 400", async () => {
    const s = await setup();
    const forge = async (payload: Record<string, unknown>, secret = STATE_SECRET) => sign(`oauth1.${base64urlEncode(utf8(JSON.stringify(payload)))}`, secret);
    const jar = new Jar();
    const url = new URL((await start(s, jar, "idp")).headers.get("location")!);
    const state = url.searchParams.get("state")!;
    const good = jar.cookies.get("miu_oauth")!;
    const cases: string[] = [
      good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA"),
      await forge({ p: "idp", s: state, v: "v".repeat(43), n: "n", r: "/", e: Date.now() - 1 }),
      await forge({ p: "github", s: state, v: "v".repeat(43), n: "n", r: "/", e: Date.now() + 60_000 }),
      await forge({ p: "idp", s: state, v: "v".repeat(43), n: "n", r: "/", e: Date.now() + 60_000 }, "some-other-secret-that-is-long-enough-xyz"),
      encodeURIComponent(await sign("not-our-format", STATE_SECRET)),
    ];
    for (const [i, cookie] of cases.entries()) {
      const j = new Jar();
      j.cookies.set("miu_oauth", cookie);
      const res = await callback(s, j, "idp", { code: s.idp.authorize(url, ANN), state });
      expect([i, res.status]).toEqual([i, 400]);
      expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_STATE");
    }
    await noUser(s);
  });

  test("the callback cannot be replayed", async () => {
    const s = await setup();
    const jar = new Jar();
    const url = new URL((await start(s, jar, "idp")).headers.get("location")!);
    const saved = new Map(jar.cookies);
    const code = s.idp.authorize(url, ANN);
    expect((await callback(s, jar, "idp", { code, state: url.searchParams.get("state")! })).status).toBe(302);
    expect(jar.cookies.has("miu_oauth")).toBe(false);
    const replay = new Jar();
    replay.cookies = saved;
    const again = await callback(s, replay, "idp", { code, state: url.searchParams.get("state")! });
    expect(again.status).not.toBe(302);
  });

  test("provider error (user cancelled) → 400 MIU_E_AUTH_OAUTH_DENIED; the cookie is cleared", async () => {
    const s = await setup();
    const jar = new Jar();
    const url = new URL((await start(s, jar, "idp")).headers.get("location")!);
    const res = await callback(s, jar, "idp", { error: "access_denied", state: url.searchParams.get("state")! });
    expect(res.status).toBe(400);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_DENIED");
    expect(jar.cookies.has("miu_oauth")).toBe(false);
  });

  test("token endpoint failure → 502 MIU_E_AUTH_OAUTH_TOKEN", async () => {
    const s = await setup();
    s.idp.state.tokenError = { status: 400, body: { error: "invalid_client" } };
    const { res } = await signInWith(s, ANN);
    expect(res.status).toBe(502);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_TOKEN");
    await noUser(s);
  });

  test("the token request carries the PKCE verifier for the challenge sent at start, and the client credentials", async () => {
    const s = await setup();
    const { url } = await signInWith(s, ANN);
    const form = s.idp.state.lastTokenRequest!;
    expect(await s256(form.get("code_verifier")!)).toBe(url.searchParams.get("code_challenge")!);
    expect(form.get("redirect_uri")).toBe(`${APP_URL}/auth/oauth/idp/callback`);
    expect(form.get("client_secret")).toBe("idp-secret");
  });

  const idTokenCases: [string, Parameters<typeof setup>[0], (s: S) => Promise<void>][] = [
    ["wrong issuer", {}, async (s) => void (s.idp.state.next = { claims: { iss: "https://evil.example" } })],
    ["wrong audience", {}, async (s) => void (s.idp.state.next = { claims: { aud: "someone-else" } })],
    ["audience array without us", {}, async (s) => void (s.idp.state.next = { claims: { aud: ["a", "b"] } })],
    ["audience array with us but azp of another client", {}, async (s) => void (s.idp.state.next = { claims: { aud: ["idp-client", "b"], azp: "b" } })],
    ["expired", {}, async (s) => void (s.idp.state.next = { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } })],
    ["no exp", {}, async (s) => void (s.idp.state.next = { claims: { exp: undefined } })],
    ["wrong nonce", {}, async (s) => void (s.idp.state.next = { claims: { nonce: "attacker-nonce" } })],
    ["missing nonce", {}, async (s) => void (s.idp.state.next = { claims: { nonce: undefined } })],
    ["missing sub", {}, async (s) => void (s.idp.state.next = { claims: { sub: undefined } })],
    ["bad signature", {}, async (s) => void (s.idp.state.next = { badSignature: true })],
    ["signed by an unpublished key", {}, async (s) => {
      const key = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      s.idp.state.next = { key };
    }],
    ["alg HS256", {}, async (s) => void (s.idp.state.next = { header: { alg: "HS256" } })],
    ["no id_token at all", {}, async (s) => void (s.idp.state.next = { omit: true })],
  ];
  for (const [name, cfg, arrange] of idTokenCases) {
    test(`id_token rejected: ${name} → 401 MIU_E_AUTH_OAUTH_ID_TOKEN, nobody signed in`, async () => {
      const s = await setup(cfg);
      await arrange(s);
      const { res, jar } = await signInWith(s, ANN);
      expect(res.status).toBe(401);
      expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_ID_TOKEN");
      expect((await me(s, jar)).status).toBe(401);
      await noUser(s);
    });
  }

  test("discovery whose issuer does not match the configured one is refused", async () => {
    const s = await setup();
    s.idp.state.discoveryOverride = { issuer: "https://evil.example", authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` };
    const res = await start(s, new Jar(), "idp");
    expect(res.status).toBe(502);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_DISCOVERY");
  });
});

// ---------------------------------------------------------------------------------------------

describe("discovery and JWKS caching", () => {
  test("discovery and JWKS are fetched once for many sign-ins", async () => {
    const s = await setup();
    await signInWith(s, ANN);
    await signInWith(s, ANN);
    await signInWith(s, { ...ANN, sub: "b", email: "b@example.com" });
    const count = (suffix: string) => s.net.calls.filter((c) => c.url === `${ISSUER}${suffix}`).length;
    expect(count("/.well-known/openid-configuration")).toBe(1);
    expect(count("/jwks")).toBe(1);
  });

  test("a rotated signing key (unknown kid) triggers one JWKS refetch", async () => {
    const s = await setup();
    await signInWith(s, ANN);
    await s.idp.rotate("k2");
    const { res } = await signInWith(s, ANN);
    expect(res.status).toBe(302);
    expect(s.net.calls.filter((c) => c.url === `${ISSUER}/jwks`).length).toBe(2);
  });

  test("tokens with unknown kids cannot force a JWKS refetch on every request", async () => {
    const s = await setup();
    await signInWith(s, ANN);
    for (let i = 0; i < 3; i++) {
      s.idp.state.next = { header: { kid: `nope-${i}` } };
      expect((await signInWith(s, ANN)).res.status).toBe(401);
    }
    expect(s.net.calls.filter((c) => c.url === `${ISSUER}/jwks`).length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------

describe("GitHub", () => {
  async function github(s: S, profile: { user: Record<string, unknown>; emails: unknown[] }, jar = new Jar()) {
    const st = await start(s, jar, "github");
    const url = new URL(st.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    const code = s.github.authorize(url, profile);
    const res = await callback(s, jar, "github", { code, state: url.searchParams.get("state")! });
    return { res, jar, url };
  }
  const OCTO = { id: 42, login: "octo", name: "Octo Cat" };

  test("reads the user and the verified primary email from the API", async () => {
    const s = await setup();
    const { res, jar, url } = await github(s, {
      user: OCTO,
      emails: [
        { email: "other@example.com", primary: false, verified: true },
        { email: "octo@example.com", primary: true, verified: true },
      ],
    });
    expect(res.status).toBe(302);
    expect(url.searchParams.get("scope")).toContain("user:email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await me(s, jar)).body).toMatchObject({ email: "octo@example.com", name: "Octo Cat" });
    expect(await s.users.findOAuthAccount!("github", "42", {})).not.toBeNull();
    expect(s.github.state.apiCalls.every((c) => c.ua && c.auth?.startsWith("Bearer "))).toBe(true);
  });

  test("an unverified primary email (even with a verified secondary) never links", async () => {
    const s = await setup();
    await send(s, new Jar(), "/auth/register", { email: "octo@example.com", password: PW });
    const victim = (await s.users.findUserByEmail("octo@example.com", {}))!;
    await s.users.markEmailVerified!(victim.id, Date.now(), {});
    const { jar } = await github(s, {
      user: OCTO,
      emails: [
        { email: "octo@example.com", primary: true, verified: false },
        { email: "x@example.com", primary: false, verified: true },
      ],
    });
    const who = (await me(s, jar)).body!;
    expect(who.id).not.toBe(victim.id);
    expect(String(who.email)).toMatch(/@oauth\.invalid$/);
  });

  test("GitHub's 200-with-error token response is a failure", async () => {
    const s = await setup();
    s.github.state.tokenOkButError = true;
    const { res } = await github(s, { user: OCTO, emails: [] });
    expect(res.status).toBe(502);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_TOKEN");
  });
});

describe("Discord", () => {
  test("uses /users/@me and its verified flag", async () => {
    const s = await setup();
    const run = async (user: Record<string, unknown>) => {
      const jar = new Jar();
      const url = new URL((await start(s, jar, "discord")).headers.get("location")!);
      expect(url.origin).toBe("https://discord.com");
      const res = await callback(s, jar, "discord", { code: s.discord.authorize(url, user), state: url.searchParams.get("state")! });
      expect(res.status).toBe(302);
      return (await me(s, jar)).body!;
    };
    expect(await run({ id: "1", username: "d", global_name: "Dee", email: "dee@example.com", verified: true })).toMatchObject({ email: "dee@example.com", name: "Dee" });
    expect(String((await run({ id: "2", username: "e", email: "e@example.com", verified: false })).email)).toMatch(/@oauth\.invalid$/);
  });
});

// ---------------------------------------------------------------------------------------------

let appleKeys: CryptoKeyPair | undefined;
async function appleConfig() {
  appleKeys ??= (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", appleKeys.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { clientId: "com.example.web", teamId: "TEAM123456", keyId: "KEY1234567", privateKey: pem };
}

describe("Apple", () => {
  async function appleSetup() {
    const config = await appleConfig();
    const pub = { ...(await crypto.subtle.exportKey("jwk", appleKeys!.publicKey)), kid: "KEY1234567" };
    const seen: Record<string, unknown>[] = [];
    const apple = await fakeOidc({
      issuer: "https://appleid.apple.com",
      clientId: "com.example.web",
      alg: "RS256",
      clientSecretCheck: async (secret) => {
        try {
          const { header, payload } = await verifyJws(secret, async () => pub);
          seen.push({ header, payload });
          return true;
        } catch {
          return false;
        }
      },
    });
    const net = fakeFetch(apple.handle);
    const users = memoryUserStore();
    const app = miu({
      logLevel: "silent",
      plugins: [session({ secret: SECRET }), auth({ users, password: FAST, appUrl: APP_URL, oauth: { fetch: net.fetch, secret: STATE_SECRET, apple: config } })],
    });
    return { app, apple, seen, users };
  }

  test("form_post: authorize asks for it, the state cookie is SameSite=None; Secure, and the cross-site POST callback signs in", async () => {
    const { app, apple, seen } = await appleSetup();
    const jar = new Jar();
    const st = await app.fetch(jar.request(`${BASE}/auth/oauth/apple?returnTo=/home`));
    jar.store(st);
    const url = new URL(st.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/authorize");
    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(url.searchParams.get("scope")).toBe("name email");
    const cookie = st.headers.getSetCookie().find((c) => c.startsWith("miu_oauth="))!;
    expect(cookie).toMatch(/SameSite=None/);
    expect(cookie).toMatch(/Secure/);
    const code = apple.authorize(url, { sub: "apple-1", email: "ann@privaterelay.appleid.com", email_verified: "true" });
    const form = new URLSearchParams({ code, state: url.searchParams.get("state")!, user: JSON.stringify({ name: { firstName: "Ann", lastName: "Lee" } }) });
    const res = await app.fetch(
      new Request(`${BASE}/auth/oauth/apple/callback`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com", "sec-fetch-site": "cross-site", cookie: jar.header() },
        body: form.toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/home");
    jar.store(res);
    const who = await app.fetch(jar.request(`${BASE}/auth/me`));
    expect(((await who.json()) as { user: Record<string, unknown> }).user).toMatchObject({ email: "ann@privaterelay.appleid.com", name: "Ann Lee" });
    // The client secret is an ES256 JWT for Apple, signed with the configured key.
    const { header, payload } = seen[0] as { header: Record<string, unknown>; payload: Record<string, number | string> };
    expect(header).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(payload).toMatchObject({ iss: "TEAM123456", sub: "com.example.web", aud: "https://appleid.apple.com" });
    expect(Number(payload.exp)).toBeGreaterThan(Date.now() / 1000);
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(180 * 86400);
  });

  test("the POST callback still needs the state cookie and matching state", async () => {
    const { app, apple } = await appleSetup();
    const jar = new Jar();
    const st = await app.fetch(jar.request(`${BASE}/auth/oauth/apple`));
    const url = new URL(st.headers.get("location")!);
    const code = apple.authorize(url, { sub: "apple-1", email: "x@example.com", email_verified: "true" });
    const res = await app.fetch(
      new Request(`${BASE}/auth/oauth/apple/callback`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com" },
        body: new URLSearchParams({ code, state: url.searchParams.get("state")! }).toString(),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MIU_E_AUTH_OAUTH_STATE");
  });

  test("providers without form_post get no POST callback", async () => {
    const s = await setup();
    const res = await s.app.fetch(new Request(`${BASE}/auth/oauth/idp/callback`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=x&state=y" }));
    expect([404, 405]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------------------------

describe("linking providers to the signed-in account", () => {
  async function registered(s: S, email = "ann@example.com") {
    const jar = new Jar();
    expect((await send(s, jar, "/auth/register", { email, password: PW })).status).toBe(201);
    return jar;
  }
  /** Starts with ?link=1 in `jar` and completes the provider round trip. */
  async function linkWith(s: S, jar: Jar, claims: Record<string, unknown>, provider = "idp") {
    const st = await s.app.fetch(jar.request(`${BASE}/auth/oauth/${provider}?link=1&returnTo=/settings`));
    jar.store(st);
    if (st.status !== 302) return { res: st };
    const url = new URL(st.headers.get("location")!);
    const code = (provider === "google" ? s.google : s.idp).authorize(url, claims);
    return { res: await callback(s, jar, provider, { code, state: url.searchParams.get("state")! }), url };
  }
  const accounts = async (s: S, jar: Jar) => {
    const r = await s.app.fetch(jar.request(`${BASE}/auth/oauth/accounts`));
    return { status: r.status, body: r.status === 200 ? ((await r.json()) as { accounts: Record<string, unknown>[] }).accounts : null };
  };
  const unlink = (s: S, jar: Jar, provider: string) => s.app.fetch(jar.request(`${BASE}/auth/oauth/accounts/${provider}`, { method: "DELETE" }));

  test("a signed-in user links a provider identity even when the emails differ; it then signs in to that user", async () => {
    const s = await setup();
    const jar = await registered(s);
    const ann = (await me(s, jar)).body!;
    const { res } = await linkWith(s, jar, { sub: "work-1", email: "ann@work.example", email_verified: false });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings");
    expect((await me(s, jar)).body!.id).toBe(ann.id);
    expect((await s.users.findOAuthAccount!("idp", "work-1", {}))!.userId).toBe(ann.id as string);
    const again = await signInWith(s, { sub: "work-1", email: "ann@work.example", email_verified: false });
    expect((await me(s, again.jar)).body!.id).toBe(ann.id);
    const list = await accounts(s, jar);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ provider: "idp", email: "ann@work.example", createdAt: expect.any(Number) }]);
  });

  test("link=1 needs a signed-in browser session: 401 signed out, 403 with an API token", async () => {
    const s = await setup();
    const signedOut = await s.app.fetch(new Jar().request(`${BASE}/auth/oauth/idp?link=1`));
    expect(signedOut.status).toBe(401);
    const jar = await registered(s);
    const token = (await (await send(s, jar, "/auth/tokens", { name: "t" })).json()).token as string;
    const viaToken = await s.app.fetch(new Request(`${BASE}/auth/oauth/idp?link=1`, { headers: { authorization: `Bearer ${token}` } }));
    expect(viaToken.status).toBe(403);
    expect((await errCode(viaToken)).code).toBe("MIU_E_AUTH_OAUTH_SESSION_REQUIRED");
  });

  test("a subject already linked to another user cannot be linked again (409), nothing changes", async () => {
    const s = await setup();
    const first = await signInWith(s, { sub: "shared", email: "x@example.com", email_verified: true });
    const owner = (await me(s, first.jar)).body!.id;
    const jar = await registered(s, "bob@example.com");
    const { res } = await linkWith(s, jar, { sub: "shared", email: "x@example.com", email_verified: true });
    expect(res.status).toBe(409);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_ALREADY_LINKED");
    expect((await s.users.findOAuthAccount!("idp", "shared", {}))!.userId).toBe(owner as string);
    expect((await accounts(s, jar)).body).toEqual([]);
  });

  test("relinking the same subject to the same user is fine; a second subject of the same provider is refused", async () => {
    const s = await setup();
    const jar = await registered(s);
    expect((await linkWith(s, jar, { sub: "a1" })).res.status).toBe(302);
    expect((await linkWith(s, jar, { sub: "a1" })).res.status).toBe(302);
    const other = await linkWith(s, jar, { sub: "a2" });
    expect(other.res.status).toBe(409);
    expect((await errCode(other.res)).code).toBe("MIU_E_AUTH_OAUTH_ALREADY_LINKED");
  });

  test("a link started by one user cannot complete for another user signed in later in the same browser", async () => {
    const s = await setup();
    const jar = await registered(s);
    await registered(s, "bob@example.com");
    const st = await s.app.fetch(jar.request(`${BASE}/auth/oauth/idp?link=1`));
    jar.store(st);
    const url = new URL(st.headers.get("location")!);
    await send(s, jar, "/auth/login", { email: "bob@example.com", password: PW });
    const res = await callback(s, jar, "idp", { code: s.idp.authorize(url, { sub: "z" }), state: url.searchParams.get("state")! });
    expect(res.status).toBe(400);
    expect((await errCode(res)).code).toBe("MIU_E_AUTH_OAUTH_STATE");
    expect(await s.users.findOAuthAccount!("idp", "z", {})).toBeNull();
  });

  test("a link started while signed in fails if the session is gone at the callback", async () => {
    const s = await setup();
    const jar = await registered(s);
    const st = await s.app.fetch(jar.request(`${BASE}/auth/oauth/idp?link=1`));
    jar.store(st);
    const url = new URL(st.headers.get("location")!);
    await send(s, jar, "/auth/logout", {});
    const res = await callback(s, jar, "idp", { code: s.idp.authorize(url, { sub: "z" }), state: url.searchParams.get("state")! });
    expect(res.status).toBe(400);
    expect(await s.users.findOAuthAccount!("idp", "z", {})).toBeNull();
  });

  test("the unverified-account 409 can be resolved: sign in with the password, then link", async () => {
    const s = await setup();
    const jar = await registered(s);
    expect((await signInWith(s, ANN)).res.status).toBe(409);
    expect((await linkWith(s, jar, ANN)).res.status).toBe(302);
    const later = await signInWith(s, ANN);
    expect((await me(s, later.jar)).body!.id).toBe((await me(s, jar)).body!.id);
  });

  test("GET/DELETE accounts need sign-in", async () => {
    const s = await setup();
    expect((await accounts(s, new Jar())).status).toBe(401);
    expect((await unlink(s, new Jar(), "idp")).status).toBe(401);
  });

  test("unlink removes the identity; unknown links → 404; you cannot unlink another user's link", async () => {
    const s = await setup();
    const jar = await registered(s);
    await linkWith(s, jar, { sub: "u1" });
    const bob = await registered(s, "bob@example.com");
    expect((await unlink(s, bob, "idp")).status).toBe(404);
    expect((await unlink(s, jar, "google")).status).toBe(404);
    expect((await unlink(s, jar, "idp")).status).toBe(204);
    expect(await s.users.findOAuthAccount!("idp", "u1", {})).toBeNull();
    expect((await accounts(s, jar)).body).toEqual([]);
  });

  test("unlinking the last way to sign in is refused (409) with a fix; with another provider it is allowed", async () => {
    const s = await setup();
    const { jar } = await signInWith(s, ANN); // OAuth-only: no usable password, no passkey
    const res = await unlink(s, jar, "idp");
    expect(res.status).toBe(409);
    const e = await errCode(res);
    expect(e.code).toBe("MIU_E_AUTH_OAUTH_LAST_METHOD");
    expect(e.fix).toBeTruthy();
    expect(await s.users.findOAuthAccount!("idp", "ann-1", {})).not.toBeNull();
    expect((await linkWith(s, jar, { sub: "g-1", email: "other@example.com", email_verified: true }, "google")).res.status).toBe(302);
    expect((await unlink(s, jar, "idp")).status).toBe(204);
    expect((await unlink(s, jar, "google")).status).toBe(409);
  });

  test("a user with a password can unlink their only provider", async () => {
    const s = await setup();
    const jar = await registered(s);
    await linkWith(s, jar, { sub: "u1" });
    expect((await unlink(s, jar, "idp")).status).toBe(204);
  });

  test("works with dbUserStore", async () => {
    const s = await setup({ users: dbUserStore(sqlite()) });
    const jar = await registered(s);
    expect((await linkWith(s, jar, { sub: "d1", email: "d@example.com" })).res.status).toBe(302);
    expect((await accounts(s, jar)).body!.map((a) => a.provider)).toEqual(["idp"]);
    expect((await unlink(s, jar, "idp")).status).toBe(204);
  });

  test("\"accounts\" is reserved and cannot be a provider id", async () => {
    const app = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST, oauth: { oidc: [{ id: "accounts", issuer: ISSUER, clientId: "c", clientSecret: "s" }] } })] });
    expect((await app.ready().catch((e) => e))?.code).toBe("MIU_E_AUTH_OAUTH_CONFIG");
  });
});
