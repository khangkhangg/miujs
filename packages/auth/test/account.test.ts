// Email verification, password reset and password change (opt-in features).
import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { memorySessionStore, session, type SessionStore } from "@miujs/session";
import { sqlite } from "@miujs/db";
import { createMailer, mail, memoryTransport, type MemoryTransport, type OutgoingMail } from "../../mail/src/index.ts";
import { auth, dbUserStore, memoryUserStore, type AuthOptions, type UserStore } from "../src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";

const BASE = "http://localhost";
const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };
const APP_URL = "https://app.example";
const PW = "correct horse battery";
const HOUR = 3_600_000;

interface Made {
  app: ReturnType<typeof miu>;
  users: UserStore;
  outbox: MemoryTransport;
}

function makeApp(opts: Partial<AuthOptions> = {}, extra: { store?: SessionStore; dev?: boolean } = {}): Made {
  const users = opts.users ?? memoryUserStore();
  const outbox = memoryTransport();
  const mailer = createMailer({ transport: outbox, from: "App <noreply@app.example>" });
  const app = miu({
    logLevel: "silent",
    mcp: true,
    dev: extra.dev,
    plugins: [session({ secret: SECRET, store: extra.store }), auth({ users, password: FAST, mailer, appUrl: APP_URL, ...opts })],
    routes: [route.get("/sid", { handler: (c) => ({ id: c.session.id }) })],
  });
  return { app, users, outbox };
}

const post = (jar: Jar, path: string, body: unknown, headers: Record<string, string> = {}) =>
  jar.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function send(app: Made["app"], jar: Jar, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(post(jar, path, body, headers));
  jar.store(res);
  return res;
}

const me = (app: Made["app"], jar: Jar) => app.fetch(jar.request(`${BASE}/auth/me`));
const tokenIn = (m: OutgoingMail) => /token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1] ?? null;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function sha256hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rewrites an emailed token's expiry in the store. */
async function expire(users: UserStore, token: string, purpose: "verify" | "reset") {
  const rec = (await users.consumeOneTimeToken!(await sha256hex(token), purpose, {}))!;
  expect(rec).not.toBeNull();
  await users.createOneTimeToken!({ ...rec, expiresAt: Date.now() - 1 }, {});
}

async function registerUser(m: Made, email = "ann@example.com", password = PW) {
  const jar = new Jar();
  const res = await send(m.app, jar, "/auth/register", { email, password });
  return { jar, res };
}

async function forgot(m: Made, email: string, headers: Record<string, string> = {}) {
  return m.app.fetch(post(new Jar(), "/auth/password/forgot", { email }, headers));
}

// ---------------------------------------------------------------------------------------------

describe("wiring", () => {
  test("default auth() serves none of the new routes", async () => {
    const app = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST })] });
    await app.ready();
    expect(app.routes().filter((r) => r.path.includes("password") || r.path.includes("verify"))).toEqual([]);
  });

  test("with a mailer: reset + change routes; verify routes only when verification is on", async () => {
    const off = makeApp();
    await off.app.ready();
    const paths = (a: Made["app"]) => a.routes().map((r) => `${r.method} ${r.path}`);
    expect(paths(off.app)).toEqual(expect.arrayContaining(["POST /auth/password/forgot", "POST /auth/password/reset", "POST /auth/password/change"]));
    expect(paths(off.app).some((p) => p.includes("verify"))).toBe(false);
    const on = makeApp({ emailVerification: "optional" });
    await on.app.ready();
    expect(paths(on.app)).toEqual(expect.arrayContaining(["POST /auth/verify-email/request", "POST /auth/verify-email"]));
  });

  test("every new POST route is csrf-always and hidden from MCP", async () => {
    const { app } = makeApp({ emailVerification: "required" });
    await app.ready();
    const info = app.inspect();
    const added = info.routes.filter((r) => r.path.includes("password") || r.path.includes("verify"));
    expect(added).toHaveLength(5);
    for (const r of added) {
      expect(r.method).toBe("POST");
      expect(r.tags).toContain("csrf-always");
      expect(r.summary).toBeTruthy();
      expect(info.mcp!.tools.some((t) => t.includes(r.name))).toBe(false);
    }
  });

  test("a cross-site POST to password/forgot is blocked (no cookie needed)", async () => {
    const m = makeApp();
    const res = await forgot(m, "ann@example.com", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("MIU_E_CSRF");
  });

  test("emailVerification without any mailer is a startup error with a fix", async () => {
    const app = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST, emailVerification: "required" })] });
    const err = await app.ready().catch((e) => e);
    expect(err.code).toBe("MIU_E_AUTH_MAILER_MISSING");
    expect(err.fix).toContain("mail(");
  });

  test("a store without the new methods is a startup error with a fix", async () => {
    const base = memoryUserStore();
    const legacy: UserStore = {
      kind: "legacy",
      findUserByEmail: base.findUserByEmail,
      findUserById: base.findUserById,
      createUser: base.createUser,
      updatePasswordHash: base.updatePasswordHash,
      createToken: base.createToken,
      findTokenByHash: base.findTokenByHash,
      deleteToken: base.deleteToken,
    };
    const err = await makeApp({ users: legacy }).app.ready().catch((e) => e);
    expect(err.code).toBe("MIU_E_AUTH_STORE_UNSUPPORTED");
    expect(err.fix).toBeTruthy();
  });

  test("uses ctx.mail from the mail plugin when no mailer is passed", async () => {
    const outbox = memoryTransport();
    const app = miu({
      logLevel: "silent",
      plugins: [session({ secret: SECRET }), mail({ transport: outbox, from: "noreply@app.example" }), auth({ password: FAST, appUrl: APP_URL, emailVerification: "optional" })],
    });
    await app.fetch(post(new Jar(), "/auth/register", { email: "ann@example.com", password: PW }));
    const [m] = await outbox.waitFor(1);
    expect(m.to).toEqual(["ann@example.com"]);
    expect(m.text).toContain(`${APP_URL}/verify-email?token=`);
  });

  test("production without appUrl is a startup error (Host header poisoning)", async () => {
    const m = makeApp({ appUrl: undefined }, { dev: false });
    const err = await m.app.ready().catch((e) => e);
    expect(err.code).toBe("MIU_E_AUTH_APP_URL_MISSING");
    expect(err.fix).toContain("appUrl");
  });

  test("links use appUrl, never the request's Host", async () => {
    const m = makeApp();
    await m.users.createUser({ email: "ann@example.com", roles: [], passwordHash: "x" }, {});
    const res = await m.app.fetch(
      new Jar().request("http://evil.example/auth/password/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@example.com" }) }),
    );
    expect(res.status).toBe(202);
    const [mail] = await m.outbox.waitFor(1);
    expect(mail.text).toContain(`${APP_URL}/reset-password?token=`);
    expect(mail.text + (mail.html ?? "")).not.toContain("evil.example");
  });

  test("in dev without appUrl, links fall back to the request origin", async () => {
    const m = makeApp({ appUrl: undefined }, { dev: true });
    await m.users.createUser({ email: "ann@example.com", roles: [], passwordHash: "x" }, {});
    await forgot(m, "ann@example.com");
    const [mail] = await m.outbox.waitFor(1);
    expect(mail.text).toContain(`${BASE}/reset-password?token=`);
  });

  test("inspect() shows the new settings", () => {
    const info = auth({ password: FAST, emailVerification: "required", appUrl: APP_URL, mailer: { send: async () => {} } }).inspect();
    expect(info).toMatchObject({ emailVerification: "required", appUrl: APP_URL, mailer: "custom" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("email verification: optional", () => {
  test("register signs in as before and emails a verify link", async () => {
    const m = makeApp({ emailVerification: "optional" });
    const { res, jar } = await registerUser(m);
    expect(res.status).toBe(201);
    expect((await res.json()).user).toMatchObject({ email: "ann@example.com", emailVerified: false });
    expect((await me(m.app, jar)).status).toBe(200);
    const [mail] = await m.outbox.waitFor(1);
    expect(mail.to).toEqual(["ann@example.com"]);
    expect(tokenIn(mail)).toBeTruthy();
  });

  test("POST /verify-email with the emailed token verifies the address", async () => {
    const m = makeApp({ emailVerification: "optional" });
    const { jar } = await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    const res = await send(m.app, new Jar(), "/auth/verify-email", { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "verified" });
    expect((await (await me(m.app, jar)).json()).user.emailVerified).toBe(true);
    const u = (await m.users.findUserByEmail("ann@example.com", {}))!;
    expect(u.emailVerifiedAt).toBeGreaterThan(0);
  });

  test("verify does not sign anyone in", async () => {
    const m = makeApp({ emailVerification: "optional" });
    await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    const stranger = new Jar();
    await send(m.app, stranger, "/auth/verify-email", { token });
    expect((await me(m.app, stranger)).status).toBe(401);
  });

  test("a verify token works once", async () => {
    const m = makeApp({ emailVerification: "optional" });
    await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    expect((await send(m.app, new Jar(), "/auth/verify-email", { token })).status).toBe(200);
    const again = await send(m.app, new Jar(), "/auth/verify-email", { token });
    expect(again.status).toBe(400);
    const body = await again.json();
    expect(body.error.code).toBe("MIU_E_AUTH_VERIFY_INVALID");
    expect(body.error.fix).toBeTruthy();
  });

  test("a garbage or tampered token is rejected", async () => {
    const m = makeApp({ emailVerification: "optional" });
    await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const t of ["nope", "", tampered]) expect((await send(m.app, new Jar(), "/auth/verify-email", { token: t })).status).toBe(400);
    expect((await m.users.findUserByEmail("ann@example.com", {}))!.emailVerifiedAt).toBeNull();
  });

  test("verify tokens expire after 24 hours", async () => {
    const m = makeApp({ emailVerification: "optional" });
    await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    const rec = (await m.users.consumeOneTimeToken!(await sha256hex(token), "verify", {}))!;
    expect(rec.expiresAt - rec.createdAt).toBe(24 * HOUR);
    await m.users.createOneTimeToken!({ ...rec, expiresAt: Date.now() - 1 }, {});
    expect((await send(m.app, new Jar(), "/auth/verify-email", { token })).status).toBe(400);
  });

  test("a reset token cannot verify an email", async () => {
    const m = makeApp({ emailVerification: "optional" });
    await registerUser(m);
    await m.outbox.waitFor(1);
    await forgot(m, "ann@example.com");
    const reset = tokenIn((await m.outbox.waitFor(2))[1])!;
    expect((await send(m.app, new Jar(), "/auth/verify-email", { token: reset })).status).toBe(400);
  });

  test("only the token's SHA-256 is stored", async () => {
    const database = sqlite();
    const m = makeApp({ emailVerification: "optional", users: dbUserStore(database) });
    await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    const row = await database.prepare("SELECT * FROM auth_one_time_tokens").first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.token_hash).toBe(await sha256hex(token));
  });

  test("POST /verify-email/request (signed in) sends a fresh link; the old one stops working", async () => {
    const m = makeApp({ emailVerification: "optional" });
    const { jar } = await registerUser(m);
    const first = tokenIn((await m.outbox.waitFor(1))[0])!;
    const res = await send(m.app, jar, "/auth/verify-email/request", {});
    expect(res.status).toBe(202);
    const second = tokenIn((await m.outbox.waitFor(2))[1])!;
    expect(second).not.toBe(first);
    expect((await send(m.app, new Jar(), "/auth/verify-email", { token: first })).status).toBe(400);
    expect((await send(m.app, new Jar(), "/auth/verify-email", { token: second })).status).toBe(200);
  });

  test("verify-email/request is rate-limited per account", async () => {
    const m = makeApp({ emailVerification: "optional", rateLimit: { verifyEmail: { perAccount: 2 } } });
    const { jar } = await registerUser(m);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await send(m.app, jar, "/auth/verify-email/request", {})).status);
    expect(statuses).toEqual([202, 202, 429]);
  });

  test("an already verified user gets no new mail", async () => {
    const m = makeApp({ emailVerification: "optional" });
    const { jar } = await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    await send(m.app, new Jar(), "/auth/verify-email", { token });
    const res = await send(m.app, jar, "/auth/verify-email/request", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "already-verified" });
    await tick();
    expect(m.outbox.outbox).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("email verification: required", () => {
  const CHECK = { status: "check-your-email" };

  test("register returns 202 check-your-email, does not sign in, and emails a verify link", async () => {
    const m = makeApp({ emailVerification: "required" });
    const { res, jar } = await registerUser(m);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(CHECK);
    expect((await me(m.app, jar)).status).toBe(401);
    const [mail] = await m.outbox.waitFor(1);
    expect(tokenIn(mail)).toBeTruthy();
  });

  test("registering an existing email looks identical and mails the owner instead (no enumeration)", async () => {
    const m = makeApp({ emailVerification: "required" });
    await registerUser(m);
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    await send(m.app, new Jar(), "/auth/verify-email", { token });
    const fresh = await registerUser(m, "zed@example.com");
    const dup = await registerUser(m, "ANN@example.com", "another password!");
    expect(dup.res.status).toBe(fresh.res.status);
    expect(await dup.res.json()).toEqual(await fresh.res.json());
    expect(dup.res.headers.getSetCookie().length).toBe(fresh.res.headers.getSetCookie().length);
    expect((await me(m.app, dup.jar)).status).toBe(401);
    const mails = await m.outbox.waitFor(3);
    const notice = mails.find((x) => x.to[0] === "ann@example.com" && x !== mails[0])!;
    expect(notice).toBeTruthy();
    expect(notice.text.toLowerCase()).toContain("sign");
    expect(notice.text).toContain(`${APP_URL}/forgot-password`);
    expect(tokenIn(notice)).toBeNull();
    // The existing account's password is untouched.
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(200);
  });

  test("registering an existing but unverified email resends a verify link", async () => {
    const m = makeApp({ emailVerification: "required" });
    await registerUser(m);
    await m.outbox.waitFor(1);
    await registerUser(m);
    const mails = await m.outbox.waitFor(2);
    expect(tokenIn(mails[1])).toBeTruthy();
    expect((await send(m.app, new Jar(), "/auth/verify-email", { token: tokenIn(mails[1]) })).status).toBe(200);
  });

  test("login before verifying → 403 MIU_E_AUTH_EMAIL_UNVERIFIED with a fix; after verifying → 200", async () => {
    const m = makeApp({ emailVerification: "required" });
    await registerUser(m);
    const login = () => send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: PW });
    const res = await login();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_AUTH_EMAIL_UNVERIFIED");
    expect(body.error.fix).toContain("verify-email/request");
    expect(res.headers.getSetCookie()).toEqual([]);
    await send(m.app, new Jar(), "/auth/verify-email", { token: tokenIn((await m.outbox.waitFor(1))[0]) });
    expect((await login()).status).toBe(200);
  });

  test("a wrong password for an unverified account is still the generic 401", async () => {
    const m = makeApp({ emailVerification: "required" });
    await registerUser(m);
    const res = await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: "wrong password!!" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("MIU_E_AUTH_INVALID");
  });

  test("signed-out verify-email/request takes an email and always answers the same", async () => {
    const m = makeApp({ emailVerification: "required" });
    await registerUser(m);
    await m.outbox.waitFor(1);
    const known = await send(m.app, new Jar(), "/auth/verify-email/request", { email: "ann@example.com" });
    const unknown = await send(m.app, new Jar(), "/auth/verify-email/request", { email: "nobody@example.com" });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
    const mails = await m.outbox.waitFor(2);
    await tick();
    expect(m.outbox.outbox).toHaveLength(2);
    expect(mails[1].to).toEqual(["ann@example.com"]);
  });

  test("signed-out verify-email/request without an email → 400", async () => {
    const m = makeApp({ emailVerification: "required" });
    expect((await send(m.app, new Jar(), "/auth/verify-email/request", {})).status).toBe(400);
  });

  test("sessions of unverified users (from before the switch to required) are not honored", async () => {
    const users = memoryUserStore();
    const optional = makeApp({ emailVerification: "optional", users });
    const { jar } = await registerUser(optional);
    expect((await me(optional.app, jar)).status).toBe(200);
    const required = makeApp({ emailVerification: "required", users });
    expect((await me(required.app, jar)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------

describe("password reset", () => {
  const CHECK = { status: "check-your-email" };

  async function withUser(opts: Partial<AuthOptions> = {}, extra: { store?: SessionStore } = {}) {
    const m = makeApp(opts, extra);
    const { jar } = await registerUser(m);
    if ((opts.emailVerification ?? "off") !== "off") await m.outbox.waitFor(1); // the verify mail is sent in the background
    m.outbox.clear();
    return { ...m, jar };
  }

  async function resetToken(m: Made, email = "ann@example.com") {
    const before = m.outbox.outbox.length;
    expect((await forgot(m, email)).status).toBe(202);
    const mails = await m.outbox.waitFor(before + 1);
    return tokenIn(mails[before])!;
  }

  test("forgot answers 202 with the same body for known and unknown emails; only the known one gets mail", async () => {
    const m = await withUser();
    const known = await forgot(m, "ann@example.com");
    const unknown = await forgot(m, "nobody@example.com");
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    const kb = await known.json();
    expect(kb).toEqual(CHECK);
    expect(await unknown.json()).toEqual(kb);
    expect([...known.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
    await m.outbox.waitFor(1);
    await tick();
    expect(m.outbox.outbox.map((x) => x.to[0])).toEqual(["ann@example.com"]);
  });

  test("forgot does not wait for the mail provider (timing does not reveal the account)", async () => {
    const users = memoryUserStore();
    let release!: () => void;
    const hanging = { send: () => new Promise<void>((r) => (release = r)) };
    const app = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ users, password: FAST, appUrl: APP_URL, mailer: hanging })] });
    await users.createUser({ email: "ann@example.com", roles: [], passwordHash: "x" }, {});
    const res = await Promise.race([app.fetch(post(new Jar(), "/auth/password/forgot", { email: "ann@example.com" })), tick(500).then(() => null)]);
    expect(res?.status).toBe(202);
    await tick();
    release?.();
  });

  test("forgot is rate-limited per account and per IP", async () => {
    const m = await withUser({ rateLimit: { trustProxyHeader: "cf-connecting-ip", passwordReset: { perAccount: 2, perIp: 3 } } });
    const ip = (n: number) => ({ "cf-connecting-ip": `203.0.113.${n}` });
    const perAccount = [];
    for (let i = 0; i < 3; i++) perAccount.push((await forgot(m, "ann@example.com", ip(i))).status);
    expect(perAccount).toEqual([202, 202, 429]);
    const perIp = [];
    for (let i = 0; i < 4; i++) perIp.push((await forgot(m, `u${i}@example.com`, ip(9))).status);
    expect(perIp).toEqual([202, 202, 202, 429]);
  });

  test("forgot's per-account limit counts unknown emails too (429 does not reveal existence)", async () => {
    const m = await withUser({ rateLimit: { passwordReset: { perAccount: 1 } } });
    expect((await forgot(m, "nobody@example.com")).status).toBe(202);
    expect((await forgot(m, "nobody@example.com")).status).toBe(429);
  });

  test("reset with the emailed token sets the password and signs in with a new session", async () => {
    const m = await withUser();
    const token = await resetToken(m);
    const { jar } = await registerUser(m, "bob@example.com");
    const before = (await (await m.app.fetch(jar.request(`${BASE}/sid`))).json()).id;
    const res = await send(m.app, jar, "/auth/password/reset", { token, password: "a brand new password" });
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("ann@example.com");
    expect((await me(m.app, jar)).status).toBe(200);
    const after = (await (await m.app.fetch(jar.request(`${BASE}/sid`))).json()).id;
    expect(after).not.toBe(before);
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(401);
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: "a brand new password" })).status).toBe(200);
  });

  test("a reset token works once", async () => {
    const m = await withUser();
    const token = await resetToken(m);
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "a brand new password" })).status).toBe(200);
    const again = await send(m.app, new Jar(), "/auth/password/reset", { token, password: "attacker password!" });
    expect(again.status).toBe(400);
    const body = await again.json();
    expect(body.error.code).toBe("MIU_E_AUTH_RESET_INVALID");
    expect(body.error.fix).toContain("password/forgot");
    expect(again.headers.getSetCookie().some((c) => !/max-age=0/i.test(c))).toBe(false);
  });

  test("reset tokens expire after 1 hour", async () => {
    const m = await withUser();
    const token = await resetToken(m);
    const rec = (await m.users.consumeOneTimeToken!(await sha256hex(token), "reset", {}))!;
    expect(rec.expiresAt - rec.createdAt).toBe(HOUR);
    await m.users.createOneTimeToken!(rec, {});
    await expire(m.users, token, "reset");
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "a brand new password" })).status).toBe(400);
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(200);
  });

  test("garbage, tampered and verify tokens cannot reset", async () => {
    const m = await withUser({ emailVerification: "optional" });
    await send(m.app, m.jar, "/auth/verify-email/request", {});
    const verify = tokenIn((await m.outbox.waitFor(1))[0])!;
    const reset = await resetToken(m);
    const tampered = reset.slice(0, -1) + (reset.endsWith("A") ? "B" : "A");
    for (const token of ["nope", "", tampered, verify]) {
      expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "a brand new password" })).status).toBe(400);
    }
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(200);
  });

  test("a weak new password is refused without using up the token", async () => {
    const m = await withUser();
    const token = await resetToken(m);
    const weak = await send(m.app, new Jar(), "/auth/password/reset", { token, password: "short" });
    expect(weak.status).toBe(400);
    expect((await weak.json()).error.code).toBe("MIU_E_AUTH_PASSWORD_WEAK");
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "a brand new password" })).status).toBe(200);
  });

  test("a newer reset link invalidates the older one", async () => {
    const m = await withUser();
    const first = await resetToken(m);
    const second = await resetToken(m);
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token: first, password: "a brand new password" })).status).toBe(400);
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token: second, password: "a brand new password" })).status).toBe(200);
  });

  test("reset proves email ownership: an unverified user becomes verified", async () => {
    const m = await withUser({ emailVerification: "required" });
    const token = await resetToken(m);
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "a brand new password" })).status).toBe(200);
    expect((await m.users.findUserByEmail("ann@example.com", {}))!.emailVerifiedAt).not.toBeNull();
  });

  for (const [label, store] of [["cookie store", undefined], ["server store", memorySessionStore()]] as const) {
    test(`reset signs out every other session (${label})`, async () => {
      const m = await withUser({}, { store });
      const other = new Jar();
      await send(m.app, other, "/auth/login", { email: "ann@example.com", password: PW });
      expect((await me(m.app, m.jar)).status).toBe(200);
      expect((await me(m.app, other)).status).toBe(200);
      const token = await resetToken(m);
      const fresh = new Jar();
      await send(m.app, fresh, "/auth/password/reset", { token, password: "a brand new password" });
      expect((await me(m.app, m.jar)).status).toBe(401);
      expect((await me(m.app, other)).status).toBe(401);
      expect((await me(m.app, fresh)).status).toBe(200);
    });
  }

  async function apiToken(m: Made, jar: Jar) {
    const res = await send(m.app, jar, "/auth/tokens", { name: "ci" });
    expect(res.status).toBe(201);
    return (await res.json()).token as string;
  }
  const bearer = (m: Made, token: string) => m.app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }));

  for (const [label, users] of [["memory", () => memoryUserStore()], ["db", () => dbUserStore(sqlite())]] as const) {
    test(`reset revokes every API token of the user (${label})`, async () => {
      const m = await withUser({ users: users() });
      const t1 = await apiToken(m, m.jar);
      const t2 = await apiToken(m, m.jar);
      const other = await registerUser(m, "bob@example.com");
      const bobs = await apiToken(m, other.jar);
      expect((await bearer(m, t1)).status).toBe(200);
      const token = await resetToken(m);
      expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "a brand new password" })).status).toBe(200);
      expect((await bearer(m, t1)).status).toBe(401);
      expect((await bearer(m, t2)).status).toBe(401);
      expect((await bearer(m, bobs)).status).toBe(200);
    });
  }

  test("a failed reset (bad token) revokes nothing", async () => {
    const m = await withUser();
    const t1 = await apiToken(m, m.jar);
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token: "x".repeat(43), password: "a brand new password" })).status).toBe(400);
    expect((await bearer(m, t1)).status).toBe(200);
  });

  test("with dbUserStore end to end", async () => {
    const m = await withUser({ users: dbUserStore(sqlite()) });
    const token = await resetToken(m);
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "a brand new password" })).status).toBe(200);
    expect((await me(m.app, m.jar)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------

describe("password change", () => {
  test("requires sign-in", async () => {
    const m = makeApp();
    expect((await send(m.app, new Jar(), "/auth/password/change", { currentPassword: PW, newPassword: "a brand new password" })).status).toBe(401);
  });

  test("changes the password, keeps this session, signs out the others", async () => {
    const m = makeApp();
    const { jar } = await registerUser(m);
    const other = new Jar();
    await send(m.app, other, "/auth/login", { email: "ann@example.com", password: PW });
    const res = await send(m.app, jar, "/auth/password/change", { currentPassword: PW, newPassword: "a brand new password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "password-changed" });
    expect((await me(m.app, jar)).status).toBe(200);
    expect((await me(m.app, other)).status).toBe(401);
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(401);
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: "a brand new password" })).status).toBe(200);
  });

  test("a wrong current password → 403 MIU_E_AUTH_PASSWORD_INCORRECT and nothing changes", async () => {
    const m = makeApp();
    const { jar } = await registerUser(m);
    const res = await send(m.app, jar, "/auth/password/change", { currentPassword: "wrong password!!", newPassword: "a brand new password" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("MIU_E_AUTH_PASSWORD_INCORRECT");
    expect((await me(m.app, jar)).status).toBe(200);
    expect((await send(m.app, new Jar(), "/auth/login", { email: "ann@example.com", password: PW })).status).toBe(200);
  });

  test("a weak new password → 400", async () => {
    const m = makeApp();
    const { jar } = await registerUser(m);
    expect((await send(m.app, jar, "/auth/password/change", { currentPassword: PW, newPassword: "short" })).status).toBe(400);
  });

  test("guessing the current password is rate-limited", async () => {
    const m = makeApp({ rateLimit: { login: { perIpAccount: 2 } } });
    const { jar } = await registerUser(m);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await send(m.app, jar, "/auth/password/change", { currentPassword: "wrong password!!", newPassword: "a brand new password" })).status);
    expect(statuses).toEqual([403, 403, 429]);
  });

  test("a normal password change keeps API tokens working", async () => {
    const m = makeApp();
    const { jar } = await registerUser(m);
    const created = await send(m.app, jar, "/auth/tokens", { name: "ci" });
    const token = (await created.json()).token as string;
    expect((await send(m.app, jar, "/auth/password/change", { currentPassword: PW, newPassword: "a brand new password" })).status).toBe(200);
    const res = await m.app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
  });

  test("a change invalidates outstanding reset links", async () => {
    const m = makeApp();
    const { jar } = await registerUser(m);
    await forgot(m, "ann@example.com");
    const token = tokenIn((await m.outbox.waitFor(1))[0])!;
    await send(m.app, jar, "/auth/password/change", { currentPassword: PW, newPassword: "a brand new password" });
    expect((await send(m.app, new Jar(), "/auth/password/reset", { token, password: "attacker password!" })).status).toBe(400);
  });
});
