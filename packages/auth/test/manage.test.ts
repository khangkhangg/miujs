// auth().manage(): what an operator sees and does in @miujs/admin.
import { describe, expect, test } from "bun:test";
import { miu, route, validate, type Context, type ManageAction, type ManageList, type ManageSection } from "miujs";
import { session } from "@miujs/session";
import { sqlite } from "@miujs/db";
import { createMailer, memoryTransport } from "../../mail/src/index.ts";
import { auth, dbUserStore, memoryUserStore, type AuthOptions, type UserStore } from "../src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";
import { fakeFetch, fakeOidc } from "./oauth-fakes.ts";

const BASE = "http://localhost";
const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };
const PW = "correct horse battery";
const ISSUER = "https://idp.example";

async function setup(opts: Partial<AuthOptions> = {}, extra: { mail?: boolean } = {}) {
  const users = opts.users ?? memoryUserStore();
  const outbox = memoryTransport();
  const mailer = extra.mail ? createMailer({ transport: outbox, from: "App <noreply@app.example>" }) : undefined;
  let grabbed: Context | undefined;
  const plugin = auth({ users, password: FAST, appUrl: "https://app.example", ...(mailer ? { mailer } : {}), ...opts });
  const app = miu({
    logLevel: "silent",
    plugins: [session({ secret: SECRET }), plugin],
    routes: [route.get("/__ctx", { handler: (c) => void (grabbed = c as unknown as Context) })],
  });
  await app.fetch(new Request(`${BASE}/__ctx`));
  const ctx = grabbed!;
  const sections = plugin.manage!();
  const section = sections.find((s) => s.id === "accounts")!;
  return { app, users, outbox, ctx, sections, section, plugin };
}
type S = Awaited<ReturnType<typeof setup>>;

const list = (s: S, name = "users") => s.section.lists!.find((l) => l.name === name)!;
const rowAction = (l: ManageList, name: string) => l.rowActions!.find((a) => a.name === name);
const stat = async (s: S, label: string) => (await s.section.status!(s.ctx)).stats!.find((x) => x.label === label);

async function run(s: S, a: ManageAction | undefined, input: Record<string, unknown>) {
  expect(a).toBeDefined();
  const v = a!.input ? validate(a!.input, input) : { ok: true as const, value: input };
  if (!v.ok) throw new Error(`invalid input: ${JSON.stringify(v.issues)}`);
  return a!.run(v.value, s.ctx);
}

async function register(s: S, email: string, jar = new Jar()) {
  const res = await s.app.fetch(jar.request(`${BASE}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) }));
  jar.store(res);
  return res;
}
async function login(s: S, email: string, password = PW, jar = new Jar()) {
  const res = await s.app.fetch(jar.request(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
  jar.store(res);
  return { res, jar };
}
const me = (s: S, jar: Jar) => s.app.fetch(jar.request(`${BASE}/auth/me`));

const stores: [string, () => UserStore][] = [
  ["memory", () => memoryUserStore()],
  ["db", () => dbUserStore(sqlite())],
];

describe("auth manage(): sections", () => {
  test("one 'accounts' section with status, a users list and settings; ids are well-formed", async () => {
    const s = await setup();
    expect(s.sections.map((x) => x.id)).toEqual(["accounts"]);
    for (const sec of s.sections) expect(sec.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(typeof s.section.status).toBe("function");
    expect(s.section.settings).toBeDefined();
    const names = (s.section.lists ?? []).flatMap((l) => [l.name, ...(l.rowActions ?? []).map((a) => a.name)]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
  });
});

describe.each(stores)("auth manage() status and users list (%s store)", (_name, make) => {
  test("status counts users and this instance's sign-ups, sign-ins and failed sign-ins", async () => {
    const s = await setup({ users: make() });
    expect((await stat(s, "Users"))!.value).toBe(0);
    await register(s, "a@example.com");
    await register(s, "b@example.com");
    await login(s, "a@example.com");
    await login(s, "a@example.com", "wrong password!");
    await login(s, "nobody@example.com");
    expect((await stat(s, "Users"))!.value).toBe(2);
    expect((await stat(s, "Sign-ups"))!.value).toBe(2);
    expect((await stat(s, "Sign-ins"))!.value).toBe(3); // two registrations sign in, plus one login
    expect((await stat(s, "Failed sign-ins"))!.value).toBe(2);
  });

  test("users list pages with a cursor and searches by email; rows hold no secrets", async () => {
    const s = await setup({ users: make() });
    for (const e of ["carol@example.com", "alice@example.com", "bob@other.org", "dave@example.com", "erin@example.com"]) await register(s, e);
    const l = list(s);
    expect(l.idKey).toBe("id");
    expect(l.searchable).toBe(true);
    const p1 = await l.list({ limit: 2 }, s.ctx);
    expect(p1.rows.map((r) => r.email)).toEqual(["alice@example.com", "bob@other.org"]);
    expect(p1.next).toBeString();
    const p2 = await l.list({ limit: 2, cursor: p1.next }, s.ctx);
    expect(p2.rows.map((r) => r.email)).toEqual(["carol@example.com", "dave@example.com"]);
    const p3 = await l.list({ limit: 2, cursor: p2.next }, s.ctx);
    expect(p3.rows.map((r) => r.email)).toEqual(["erin@example.com"]);
    expect(p3.next).toBeUndefined();

    const found = await l.list({ limit: 10, search: "OTHER.org" }, s.ctx);
    expect(found.rows.map((r) => r.email)).toEqual(["bob@other.org"]);
    // LIKE wildcards in the search are literal.
    expect((await l.list({ limit: 10, search: "%" }, s.ctx)).rows).toEqual([]);
    expect((await l.list({ limit: 10, search: "_" }, s.ctx)).rows).toEqual([]);

    const row = p1.rows[0];
    expect(Object.keys(row).sort()).toEqual(["createdAt", "disabled", "email", "emailVerified", "id", "name", "roles"]);
    const dump = JSON.stringify([p1, p2, p3, await s.section.status!(s.ctx)]);
    expect(dump).not.toMatch(/pbkdf2_sha256$|passwordHash|password_hash|sessionVersion/);
    expect(dump).not.toContain((await s.users.findUserByEmail("alice@example.com", {}))!.passwordHash);
  });

  test("disable signs the user out and blocks sign-in and API tokens; enable restores them", async () => {
    const s = await setup({ users: make() });
    const jar = new Jar();
    await register(s, "ann@example.com", jar);
    const tokenRes = await s.app.fetch(jar.request(`${BASE}/auth/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ci" }) }));
    const { token } = (await tokenRes.json()) as { token: string };
    const id = (await s.users.findUserByEmail("ann@example.com", {}))!.id;
    const l = list(s);
    const disable = rowAction(l, "disable")!;
    expect(disable.danger).toBe(true);

    expect(await run(s, disable, { id })).toContain("disabled");
    expect((await me(s, jar)).status).toBe(401);
    const viaToken = await s.app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
    expect(viaToken.status).toBe(401);
    const again = await login(s, "ann@example.com");
    expect(again.res.status).toBe(403);
    expect(((await again.res.json()) as { error: { code: string } }).error.code).toBe("MIU_E_AUTH_ACCOUNT_DISABLED");
    expect((await l.list({ limit: 10 }, s.ctx)).rows[0].disabled).toBe(true);
    // Idempotent.
    expect(await run(s, disable, { id })).toContain("already disabled");

    expect(await run(s, rowAction(l, "enable"), { id })).toContain("enabled");
    expect(await run(s, rowAction(l, "enable"), { id })).toContain("already enabled");
    expect((await login(s, "ann@example.com")).res.status).toBe(200);
    const tokenAgain = await s.app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
    expect(tokenAgain.status).toBe(200);
  });

  test("a session is refused once the user is disabled, even if it was not revoked", async () => {
    const s = await setup({ users: make() });
    const jar = new Jar();
    await register(s, "ann@example.com", jar);
    const id = (await s.users.findUserByEmail("ann@example.com", {}))!.id;
    await s.users.setUserDisabled!(id, Date.now(), {});
    expect((await me(s, jar)).status).toBe(401);
    await s.users.setUserDisabled!(id, null, {});
    expect((await me(s, jar)).status).toBe(200);
  });

  test("a disabled user's wrong password still answers like any failed login (no account probing)", async () => {
    const s = await setup({ users: make() });
    await register(s, "ann@example.com");
    const id = (await s.users.findUserByEmail("ann@example.com", {}))!.id;
    await run(s, rowAction(list(s), "disable"), { id });
    const r = await login(s, "ann@example.com", "not the password");
    expect(r.res.status).toBe(401);
  });

  test("revokeSessions signs out every browser session; revokeApiTokens deletes the user's API tokens", async () => {
    const s = await setup({ users: make() });
    const jar = new Jar();
    await register(s, "ann@example.com", jar);
    const other = (await login(s, "ann@example.com")).jar;
    const tokenRes = await s.app.fetch(jar.request(`${BASE}/auth/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ci" }) }));
    const { token } = (await tokenRes.json()) as { token: string };
    const id = (await s.users.findUserByEmail("ann@example.com", {}))!.id;
    const l = list(s);
    expect(rowAction(l, "revokeSessions")!.danger).toBe(true);
    expect(rowAction(l, "revokeApiTokens")!.danger).toBe(true);

    expect(String(await run(s, rowAction(l, "revokeSessions"), { id }))).toContain("signed out");
    expect((await me(s, jar)).status).toBe(401);
    expect((await me(s, other)).status).toBe(401);
    const bearer = () => s.app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
    expect((await bearer()).status).toBe(200);
    expect((await login(s, "ann@example.com")).res.status).toBe(200);

    expect(String(await run(s, rowAction(l, "revokeApiTokens"), { id }))).toContain("1 API token");
    expect((await bearer()).status).toBe(401);
    expect(String(await run(s, rowAction(l, "revokeApiTokens"), { id }))).toContain("0 API tokens");
  });

  test("row actions on an unknown user fail with a not-found error", async () => {
    const s = await setup({ users: make() });
    const l = list(s);
    for (const name of ["disable", "enable", "revokeSessions"]) {
      await expect(Promise.resolve().then(() => run(s, rowAction(l, name), { id: "nope" }))).rejects.toMatchObject({ code: "MIU_E_NOT_FOUND" });
    }
  });
});

describe("auth manage() status details", () => {
  test("lists sign-in methods by name and the hashing parameters, never secrets", async () => {
    const idp = await fakeOidc({ issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret" });
    const net = fakeFetch(idp.handle);
    const s = await setup({
      oauth: { fetch: net.fetch, secret: "oauth-state-secret-that-is-long-enough-123", github: { clientId: "gh-client", clientSecret: "gh-very-secret" }, oidc: [{ id: "idp", issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret" }] },
      passkeys: { rpId: "localhost", rpName: "Test", origins: ["http://localhost"] },
      turnstile: { secretKey: "turnstile-secret-value" },
    });
    const st = await s.section.status!(s.ctx);
    const methods = st.stats!.find((x) => x.label === "Sign-in methods")!;
    expect(methods.value).toBe("password, github, idp, passkeys");
    expect(st.stats!.find((x) => x.label === "Password hashing")!.value).toBe("pbkdf2-sha256, 1000 iterations");
    const dump = JSON.stringify(st);
    for (const secret of ["gh-very-secret", "idp-secret", "oauth-state-secret", "turnstile-secret-value", "gh-client", "idp-client"]) expect(dump).not.toContain(secret);
  });

  test("argon2id parameters when that algorithm is used", async () => {
    const s = await setup({ password: { algorithm: "argon2id", memoryCost: 1024, timeCost: 3 } });
    expect((await stat(s, "Password hashing"))!.value).toBe("argon2id, m=1024 KiB, t=3");
  });
});

describe("auth manage() settings", () => {
  test("get returns the effective values", async () => {
    const s = await setup({ minPasswordLength: 10, rateLimit: { login: { perAccount: 7 } } });
    const v = await s.section.settings!.get(s.ctx);
    expect(v).toEqual({ allowSignUps: true, minPasswordLength: 10, loginPerIpAccount: 10, loginPerAccount: 7, loginPerIp: 100, loginWindowSeconds: 900 });
  });

  test("the schema rejects bad values", () => {
    const sch = (async () => (await setup()).section.settings!.schema)();
    return sch.then((schema) => {
      const good = { allowSignUps: true, minPasswordLength: 8, loginPerIpAccount: 10, loginPerAccount: 50, loginPerIp: 100, loginWindowSeconds: 900 };
      expect(validate(schema, good).ok).toBe(true);
      for (const bad of [
        { ...good, allowSignUps: "yes" },
        { ...good, minPasswordLength: 0 },
        { ...good, minPasswordLength: 2000 },
        { ...good, minPasswordLength: 8.5 },
        { ...good, loginPerAccount: 0 },
        { ...good, loginWindowSeconds: 0 },
        { ...good, loginWindowSeconds: 86_401 },
      ]) {
        expect(validate(schema, bad).ok).toBe(false);
      }
    });
  });

  test("allowSignUps=false closes registration now; true reopens it", async () => {
    const s = await setup();
    const cur = await s.section.settings!.get(s.ctx);
    await s.section.settings!.set({ ...cur, allowSignUps: false }, s.ctx);
    const res = await register(s, "late@example.com");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MIU_E_AUTH_SIGNUPS_CLOSED");
    expect((await s.section.settings!.get(s.ctx)).allowSignUps).toBe(false);
    await s.section.settings!.set({ ...cur, allowSignUps: true }, s.ctx);
    expect((await register(s, "late@example.com")).status).toBe(201);
  });

  test("allowSignUps=false also stops OAuth from creating new accounts (existing ones still sign in)", async () => {
    const idp = await fakeOidc({ issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret" });
    const net = fakeFetch(idp.handle);
    const s = await setup({ oauth: { fetch: net.fetch, secret: "oauth-state-secret-that-is-long-enough-123", oidc: [{ id: "idp", issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret" }] } });
    const signInWith = async (claims: Record<string, unknown>) => {
      const jar = new Jar();
      const st = await s.app.fetch(jar.request(`${BASE}/auth/oauth/idp`));
      jar.store(st);
      const url = new URL(st.headers.get("location")!);
      const code = idp.authorize(url, claims);
      const res = await s.app.fetch(jar.request(`${BASE}/auth/oauth/idp/callback?${new URLSearchParams({ code, state: url.searchParams.get("state")! })}`));
      jar.store(res);
      return { res, jar };
    };
    const first = await signInWith({ sub: "ann-1", email: "ann@example.com", email_verified: true });
    expect((await me(s, first.jar)).status).toBe(200);
    const cur = await s.section.settings!.get(s.ctx);
    await s.section.settings!.set({ ...cur, allowSignUps: false }, s.ctx);
    const newcomer = await signInWith({ sub: "bob-1", email: "bob@example.com", email_verified: true });
    expect((await me(s, newcomer.jar)).status).toBe(401);
    expect(await s.users.findUserByEmail("bob@example.com", {})).toBeNull();
    const back = await signInWith({ sub: "ann-1", email: "ann@example.com", email_verified: true });
    expect((await me(s, back.jar)).status).toBe(200);
  });

  test("minPasswordLength applies to the next registration", async () => {
    const s = await setup();
    const cur = await s.section.settings!.get(s.ctx);
    await s.section.settings!.set({ ...cur, minPasswordLength: 30 }, s.ctx);
    const res = await register(s, "ann@example.com");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MIU_E_AUTH_PASSWORD_WEAK");
  });

  test("login lockout thresholds apply now", async () => {
    const s = await setup();
    await register(s, "ann@example.com");
    const cur = await s.section.settings!.get(s.ctx);
    await s.section.settings!.set({ ...cur, loginPerAccount: 2 }, s.ctx);
    expect((await login(s, "ann@example.com", "wrong password 1")).res.status).toBe(401);
    expect((await login(s, "ann@example.com", "wrong password 2")).res.status).toBe(401);
    expect((await login(s, "ann@example.com")).res.status).toBe(429);
  });

  test("with register: false, allowSignUps never adds a password sign-up route", async () => {
    const s = await setup({ register: false });
    const cur = await s.section.settings!.get(s.ctx);
    expect(cur.allowSignUps).toBe(true); // OAuth may still create accounts
    await s.section.settings!.set({ ...cur, allowSignUps: true }, s.ctx);
    expect((await register(s, "ann@example.com")).status).toBe(404);
    expect((await stat(s, "Sign-in methods"))!.hint).toContain("no password sign-up");
  });
});

describe("auth manage() optional row actions", () => {
  test("sendPasswordReset exists only with a mailer and emails a working reset link", async () => {
    const without = await setup();
    expect(rowAction(list(without), "sendPasswordReset")).toBeUndefined();

    const s = await setup({}, { mail: true });
    await s.app.ready();
    await register(s, "ann@example.com");
    const id = (await s.users.findUserByEmail("ann@example.com", {}))!.id;
    const a = rowAction(list(s), "sendPasswordReset")!;
    const out = String(await run(s, a, { id }));
    expect(out).toContain("ann@example.com");
    expect(s.outbox.outbox).toHaveLength(1);
    expect(s.outbox.outbox[0].to).toEqual(["ann@example.com"]);
    const token = /token=([A-Za-z0-9_-]+)/.exec(s.outbox.outbox[0].text)![1];
    expect(out).not.toContain(token);
    const reset = await s.app.fetch(new Jar().request(`${BASE}/auth/password/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: "a brand new passphrase" }) }));
    expect(reset.status).toBe(200);
  });

  test("unlinkOAuth exists only with OAuth, unlinks a provider and refuses the last way to sign in", async () => {
    const plain = await setup();
    expect(rowAction(list(plain), "unlinkOAuth")).toBeUndefined();

    const idp = await fakeOidc({ issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret" });
    const s = await setup({ oauth: { fetch: fakeFetch(idp.handle).fetch, secret: "oauth-state-secret-that-is-long-enough-123", github: { clientId: "c", clientSecret: "s" }, oidc: [{ id: "idp", issuer: ISSUER, clientId: "idp-client", clientSecret: "idp-secret" }] } });
    const a = rowAction(list(s), "unlinkOAuth")!;
    expect(a.danger).toBe(true);
    expect(validate(a.input!, { id: "x", provider: "myspace" }).ok).toBe(false);

    await register(s, "ann@example.com");
    const ann = (await s.users.findUserByEmail("ann@example.com", {}))!;
    await s.users.createOAuthAccount!({ id: "o1", provider: "github", subject: "gh-1", userId: ann.id, email: null, createdAt: 1 }, {});
    expect(String(await run(s, a, { id: ann.id, provider: "github" }))).toContain("Unlinked github");
    expect(await s.users.listOAuthAccounts!(ann.id, {})).toEqual([]);
    expect(String(await run(s, a, { id: ann.id, provider: "github" }))).toContain("not linked");

    // An OAuth-only user keeps their only way in.
    const oauthOnly = (await s.users.createUser({ email: "o@example.com", roles: [], passwordHash: "!unusable" }, {}))!;
    await s.users.createOAuthAccount!({ id: "o2", provider: "idp", subject: "s-2", userId: oauthOnly.id, email: null, createdAt: 1 }, {});
    await expect(Promise.resolve().then(() => run(s, a, { id: oauthOnly.id, provider: "idp" }))).rejects.toMatchObject({ code: "MIU_E_AUTH_OAUTH_LAST_METHOD" });
  });
});
