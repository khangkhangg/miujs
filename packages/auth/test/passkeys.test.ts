// Passkeys (WebAuthn): registration and sign-in with real ES256 / RS256 keys.
import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { session } from "@miujs/session";
import { sqlite } from "@miujs/db";
import { auth, dbUserStore, memoryUserStore, type AuthOptions, type PasskeyOptions, type UserStore } from "../src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";
import { FLAGS, SoftAuthenticator } from "./webauthn-fakes.ts";

const BASE = "http://localhost";
const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };
const ORIGIN = "https://app.example";
const RP = { rpId: "app.example", rpName: "Example", origins: [ORIGIN] };
const PW = "correct horse battery";

function setup(opts: { passkeys?: Partial<PasskeyOptions>; auth?: Partial<AuthOptions>; users?: UserStore } = {}) {
  const users = opts.users ?? memoryUserStore();
  const app = miu({
    logLevel: "silent",
    mcp: true,
    plugins: [session({ secret: SECRET }), auth({ users, password: FAST, passkeys: { ...RP, ...opts.passkeys }, ...opts.auth })],
  });
  return { app, users };
}
type S = ReturnType<typeof setup>;

async function req(s: S, jar: Jar, method: string, path: string, body?: unknown) {
  const res = await s.app.fetch(jar.request(`${BASE}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  jar.store(res);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function signedIn(s: S, email = "ann@example.com") {
  const jar = new Jar();
  expect((await req(s, jar, "POST", "/auth/register", { email, password: PW })).status).toBe(201);
  return jar;
}

async function register(s: S, jar: Jar, a: SoftAuthenticator, o: Parameters<SoftAuthenticator["create"]>[2] = {}, name?: string) {
  const opts = await req(s, jar, "POST", "/auth/passkeys/register/options", {});
  expect(opts.status).toBe(200);
  const credential = await a.create(opts.body, ORIGIN, o);
  return req(s, jar, "POST", "/auth/passkeys/register/verify", { credential, ...(name ? { name } : {}) });
}

async function login(s: S, a: SoftAuthenticator, o: Parameters<SoftAuthenticator["get"]>[2] = {}, jar = new Jar()) {
  const opts = await req(s, jar, "POST", "/auth/passkeys/login/options", {});
  expect(opts.status).toBe(200);
  const credential = await a.get(opts.body, ORIGIN, o);
  const res = await req(s, jar, "POST", "/auth/passkeys/login/verify", { credential });
  return { ...res, jar, credential };
}

const me = async (s: S, jar: Jar) => (await req(s, jar, "GET", "/auth/me")).status;
const newAuth = (alg: -7 | -257 = -7) => new SoftAuthenticator(alg).init();

/** A user with one registered ES256 passkey. */
async function withPasskey(s = setup(), alg: -7 | -257 = -7) {
  const jar = await signedIn(s);
  const a = await newAuth(alg);
  const r = await register(s, jar, a);
  expect(r.status).toBe(201);
  return { s, jar, a };
}

// ---------------------------------------------------------------------------------------------

describe("wiring", () => {
  test("routes exist only when passkeys are configured; none are MCP tools; POSTs are csrf-always", async () => {
    const plain = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST })] });
    await plain.ready();
    expect(plain.routes().some((r) => r.path.includes("passkeys"))).toBe(false);
    const { app } = setup();
    await app.ready();
    const info = app.inspect();
    const routes = info.routes.filter((r) => r.path.includes("/passkeys"));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "DELETE /auth/passkeys/:id",
      "GET /auth/passkeys",
      "POST /auth/passkeys/login/options",
      "POST /auth/passkeys/login/verify",
      "POST /auth/passkeys/register/options",
      "POST /auth/passkeys/register/verify",
    ]);
    for (const r of routes) {
      expect(info.mcp!.tools.some((t) => t.includes(r.name))).toBe(false);
      if (r.method === "POST") expect(r.tags).toContain("csrf-always");
    }
  });

  test("bad config is a startup error with a fix", async () => {
    for (const passkeys of [
      { rpId: "", rpName: "x", origins: [ORIGIN] },
      { rpId: "https://app.example", rpName: "x", origins: [ORIGIN] },
      { rpId: "app.example", rpName: "x", origins: [] },
      { rpId: "app.example", rpName: "x", origins: ["https://evil.example"] },
      { rpId: "app.example", rpName: "x", origins: ["http://app.example"] },
      { rpId: "app.example", rpName: "x", origins: ["https://notapp.example"] },
    ]) {
      const app = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST, passkeys })] });
      const err = await app.ready().catch((e) => e);
      expect([passkeys, err?.code]).toEqual([passkeys, "MIU_E_AUTH_PASSKEY_CONFIG"]);
      expect(err.fix).toBeTruthy();
    }
    // Subdomains of the rpId and http://localhost (dev) are fine.
    const ok = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST, passkeys: { rpId: "app.example", rpName: "x", origins: ["https://app.example", "https://www.app.example"] } })] });
    await ok.ready();
    const local = miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: FAST, passkeys: { rpId: "localhost", rpName: "x", origins: ["http://localhost:3000"] } })] });
    await local.ready();
  });

  test("a store without passkey methods is a startup error", async () => {
    const { app } = setup({ users: { ...memoryUserStore(), createPasskey: undefined, consumeChallenge: undefined } });
    const err = await app.ready().catch((e) => e);
    expect(err?.code).toBe("MIU_E_AUTH_STORE_UNSUPPORTED");
  });

  test("a cross-site POST is blocked even without a cookie", async () => {
    const s = setup();
    const res = await s.app.fetch(new Request(`${BASE}/auth/passkeys/login/options`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

describe("registration", () => {
  test("an API token cannot add a passkey (403 MIU_E_AUTH_PASSKEY_SESSION_REQUIRED)", async () => {
    const s = setup();
    const jar = await signedIn(s);
    const token = (await req(s, jar, "POST", "/auth/tokens", { name: "ci" })).body.token;
    const res = await s.app.fetch(new Request(`${BASE}/auth/passkeys/register/options`, { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MIU_E_AUTH_PASSKEY_SESSION_REQUIRED");
  });

  test("options need sign-in", async () => {
    const s = setup();
    expect((await req(s, new Jar(), "POST", "/auth/passkeys/register/options", {})).status).toBe(401);
    expect((await req(s, new Jar(), "POST", "/auth/passkeys/register/verify", { credential: {} })).status).toBe(401);
  });

  test("options: rp, user handle, fresh challenge, ES256 + RS256, attestation none, 5 min, existing credentials excluded", async () => {
    const { s, jar, a } = await withPasskey();
    const o = (await req(s, jar, "POST", "/auth/passkeys/register/options", {})).body;
    expect(o.rp).toEqual({ id: "app.example", name: "Example" });
    expect(o.user.name).toBe("ann@example.com");
    expect(o.user.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(o.challenge).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(o.pubKeyCredParams).toEqual([
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ]);
    expect(o.attestation).toBe("none");
    expect(o.timeout).toBe(300_000);
    expect(o.excludeCredentials).toEqual([{ type: "public-key", id: a.id, transports: ["internal", "hybrid"] }]);
    const again = (await req(s, jar, "POST", "/auth/passkeys/register/options", {})).body;
    expect(again.challenge).not.toBe(o.challenge);
  });

  test("ES256: verify stores the credential; GET /auth/passkeys lists it without the key", async () => {
    const s = setup();
    const jar = await signedIn(s);
    const a = await newAuth();
    const r = await register(s, jar, a, {}, "My laptop");
    expect(r.status).toBe(201);
    expect(r.body.passkey).toMatchObject({ name: "My laptop" });
    const list = await req(s, jar, "GET", "/auth/passkeys");
    expect(list.status).toBe(200);
    expect(list.body.passkeys).toHaveLength(1);
    expect(list.body.passkeys[0]).toMatchObject({ id: r.body.passkey.id, name: "My laptop", lastUsedAt: null });
    expect(JSON.stringify(list.body)).not.toContain(a.id);
  });

  test("RS256 registers and signs in too", async () => {
    const { s, a } = await withPasskey(setup(), -257);
    const { status } = await login(s, a);
    expect(status).toBe(200);
  });

  test("fmt packed is accepted (its statement is ignored, not verified)", async () => {
    const s = setup();
    const jar = await signedIn(s);
    const r = await register(s, jar, await newAuth(), { fmt: "packed", attStmt: new Map<string, number | Uint8Array>([["alg", -7], ["sig", new Uint8Array(70)]]) });
    expect(r.status).toBe(201);
  });

  const rejects: [string, Parameters<SoftAuthenticator["create"]>[2], string, Partial<PasskeyOptions>?][] = [
    ["another origin", { origin: "https://evil.example" }, "MIU_E_AUTH_PASSKEY_ORIGIN"],
    ["cross-origin iframe", { crossOrigin: true }, "MIU_E_AUTH_PASSKEY_ORIGIN"],
    ["clientData type webauthn.get", { type: "webauthn.get" }, "MIU_E_AUTH_PASSKEY_INVALID"],
    ["an unknown challenge", { challenge: "A".repeat(43) }, "MIU_E_AUTH_PASSKEY_CHALLENGE"],
    ["another RP's id hash", { rpId: "evil.example" }, "MIU_E_AUTH_PASSKEY_RP_ID"],
    ["no user presence", { flags: FLAGS.AT | FLAGS.UV }, "MIU_E_AUTH_PASSKEY_FLAGS"],
    ["no user verification when required", { flags: FLAGS.AT | FLAGS.UP }, "MIU_E_AUTH_PASSKEY_FLAGS", { userVerification: "required" }],
    ["no attested credential data", { flags: FLAGS.UP | FLAGS.UV }, "MIU_E_AUTH_PASSKEY_INVALID"],
    ["attestation fmt tpm", { fmt: "tpm" }, "MIU_E_AUTH_PASSKEY_ATTESTATION"],
    ["fmt none with a statement", { attStmt: new Map([["x", 1]]) }, "MIU_E_AUTH_PASSKEY_ATTESTATION"],
    ["EdDSA (-8)", { coseKey: new Map<never, never>([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(32)]] as never) }, "MIU_E_AUTH_PASSKEY_ALGORITHM"],
    ["ES384 (-35)", { coseKey: new Map<never, never>([[1, 2], [3, -35], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]] as never) }, "MIU_E_AUTH_PASSKEY_ALGORITHM"],
    ["an EC point not on the curve", { coseKey: new Map<never, never>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32).fill(1)], [-3, new Uint8Array(32).fill(2)]] as never) }, "MIU_E_AUTH_PASSKEY_INVALID"],
    ["a credential id that differs from authData", { authDataCredId: new Uint8Array(16).fill(7) }, "MIU_E_AUTH_PASSKEY_INVALID"],
  ];
  for (const [name, o, code, cfg] of rejects) {
    test(`rejected: ${name} → ${code}, nothing stored`, async () => {
      const s = setup({ passkeys: cfg });
      const jar = await signedIn(s);
      const r = await register(s, jar, await newAuth(), o);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.body.error.code).toBe(code);
      expect(r.body.error.fix).toBeTruthy();
      expect((await req(s, jar, "GET", "/auth/passkeys")).body.passkeys).toEqual([]);
    });
  }

  test("userVerification preferred accepts UP without UV", async () => {
    const s = setup({ passkeys: { userVerification: "preferred" } });
    const jar = await signedIn(s);
    expect((await register(s, jar, await newAuth(), { flags: FLAGS.AT | FLAGS.UP })).status).toBe(201);
  });

  test("garbage input → 400 MIU_E_AUTH_PASSKEY_INVALID (never 500)", async () => {
    const s = setup();
    const jar = await signedIn(s);
    const a = await newAuth();
    const opts = (await req(s, jar, "POST", "/auth/passkeys/register/options", {})).body;
    const good = await a.create(opts, ORIGIN);
    const bads = [
      {},
      { ...good, type: "password" },
      { ...good, response: { ...good.response, attestationObject: "!!!" } },
      { ...good, response: { ...good.response, attestationObject: "oWFhAQ" } },
      { ...good, response: { ...good.response, clientDataJSON: "bm90IGpzb24" } },
      { ...good, rawId: "AAAA" },
      "string",
    ];
    for (const credential of bads) {
      const r = await req(s, jar, "POST", "/auth/passkeys/register/verify", { credential });
      expect([credential, r.status]).toEqual([credential, 400]);
    }
  });

  test("a challenge works once", async () => {
    const s = setup();
    const jar = await signedIn(s);
    const a = await newAuth();
    const opts = (await req(s, jar, "POST", "/auth/passkeys/register/options", {})).body;
    const credential = await a.create(opts, ORIGIN);
    expect((await req(s, jar, "POST", "/auth/passkeys/register/verify", { credential })).status).toBe(201);
    const b = await newAuth();
    const again = await req(s, jar, "POST", "/auth/passkeys/register/verify", { credential: await b.create(opts, ORIGIN) });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("MIU_E_AUTH_PASSKEY_CHALLENGE");
  });

  test("a challenge expires after 5 minutes", async () => {
    const s = setup();
    const jar = await signedIn(s);
    const opts = (await req(s, jar, "POST", "/auth/passkeys/register/options", {})).body;
    const rec = (await s.users.consumeChallenge!(opts.challenge, "passkey-register", {}))!;
    expect(rec.expiresAt - rec.createdAt).toBe(300_000);
    await s.users.createChallenge!({ ...rec, expiresAt: Date.now() - 1 }, {});
    const r = await req(s, jar, "POST", "/auth/passkeys/register/verify", { credential: await (await newAuth()).create(opts, ORIGIN) });
    expect(r.body.error.code).toBe("MIU_E_AUTH_PASSKEY_CHALLENGE");
  });

  test("a challenge issued to one user cannot register a passkey for another", async () => {
    const s = setup();
    const ann = await signedIn(s);
    const bob = await signedIn(s, "bob@example.com");
    const opts = (await req(s, ann, "POST", "/auth/passkeys/register/options", {})).body;
    const r = await req(s, bob, "POST", "/auth/passkeys/register/verify", { credential: await (await newAuth()).create(opts, ORIGIN) });
    expect(r.body.error.code).toBe("MIU_E_AUTH_PASSKEY_CHALLENGE");
  });

  test("a login challenge cannot be used to register", async () => {
    const s = setup();
    const jar = await signedIn(s);
    const reg = (await req(s, jar, "POST", "/auth/passkeys/register/options", {})).body;
    const log = (await req(s, jar, "POST", "/auth/passkeys/login/options", {})).body;
    const r = await req(s, jar, "POST", "/auth/passkeys/register/verify", { credential: await (await newAuth()).create(reg, ORIGIN, { challenge: log.challenge }) });
    expect(r.body.error.code).toBe("MIU_E_AUTH_PASSKEY_CHALLENGE");
  });

  test("the same credential cannot be registered twice (even by another user) → 409", async () => {
    const { s, a } = await withPasskey();
    const bob = await signedIn(s, "bob@example.com");
    const r = await register(s, bob, a);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MIU_E_AUTH_PASSKEY_EXISTS");
  });
});

// ---------------------------------------------------------------------------------------------

describe("sign-in", () => {
  test("options: challenge, rpId, 5 min, no allowCredentials (discoverable, no account enumeration)", async () => {
    const s = setup();
    const o = (await req(s, new Jar(), "POST", "/auth/passkeys/login/options", {})).body;
    expect(o).toMatchObject({ rpId: "app.example", timeout: 300_000, userVerification: "preferred", allowCredentials: [] });
    expect(o.challenge).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  test("a valid assertion signs in with a new session and records use", async () => {
    const { s, jar: regJar, a } = await withPasskey();
    const jar = new Jar();
    await req(s, jar, "GET", "/auth/me");
    const r = await login(s, a, {}, jar);
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe("ann@example.com");
    expect(await me(s, jar)).toBe(200);
    const list = (await req(s, regJar, "GET", "/auth/passkeys")).body.passkeys;
    expect(list[0].lastUsedAt).toBeGreaterThan(0);
    expect((await s.users.findPasskeyByCredentialId!(a.id, {}))!.signCount).toBe(a.signCount);
  });

  test("authenticators that always report signCount 0 keep working", async () => {
    const { s, a } = await withPasskey();
    a.counting = false;
    expect((await login(s, a)).status).toBe(200);
    expect((await login(s, a)).status).toBe(200);
  });

  test("a signCount that does not increase is a cloned authenticator → 401 MIU_E_AUTH_PASSKEY_CLONED", async () => {
    const { s, a } = await withPasskey();
    expect((await login(s, a, { signCount: 5 })).status).toBe(200);
    for (const signCount of [5, 4]) {
      const r = await login(s, a, { signCount });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("MIU_E_AUTH_PASSKEY_CLONED");
      expect(await me(s, r.jar)).toBe(401);
    }
    // A counter of 0 after a non-zero one is also a clone signal.
    expect((await login(s, a, { signCount: 0 })).status).toBe(401);
    expect((await login(s, a, { signCount: 6 })).status).toBe(200);
  });

  test("a replayed assertion (same challenge) is refused", async () => {
    const { s, a } = await withPasskey();
    a.counting = false;
    const first = await login(s, a);
    expect(first.status).toBe(200);
    const again = await req(s, new Jar(), "POST", "/auth/passkeys/login/verify", { credential: first.credential });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("MIU_E_AUTH_PASSKEY_CHALLENGE");
  });

  test("a registration challenge cannot be used to sign in", async () => {
    const { s, jar, a } = await withPasskey();
    const reg = (await req(s, jar, "POST", "/auth/passkeys/register/options", {})).body;
    const r = await login(s, a, { challenge: reg.challenge });
    expect(r.body.error.code).toBe("MIU_E_AUTH_PASSKEY_CHALLENGE");
  });

  const rejects: [string, (a: SoftAuthenticator) => Promise<Parameters<SoftAuthenticator["get"]>[2]>, number, string, Partial<PasskeyOptions>?][] = [
    ["an unknown credential", async () => ({ credentialId: "Zm9vYmFy" }), 401, "MIU_E_AUTH_PASSKEY_INVALID"],
    ["a signature from another key", async () => ({ signWith: (await newAuth()).keys.privateKey }), 401, "MIU_E_AUTH_PASSKEY_INVALID"],
    ["clientData changed after signing", async () => ({ tamperClientData: true }), 401, "MIU_E_AUTH_PASSKEY_INVALID"],
    ["another origin", async () => ({ origin: "https://evil.example" }), 400, "MIU_E_AUTH_PASSKEY_ORIGIN"],
    ["cross-origin", async () => ({ crossOrigin: true }), 400, "MIU_E_AUTH_PASSKEY_ORIGIN"],
    ["type webauthn.create", async () => ({ type: "webauthn.create" }), 400, "MIU_E_AUTH_PASSKEY_INVALID"],
    ["another RP's id hash", async () => ({ rpId: "evil.example" }), 400, "MIU_E_AUTH_PASSKEY_RP_ID"],
    ["no user presence", async () => ({ flags: FLAGS.UV }), 401, "MIU_E_AUTH_PASSKEY_FLAGS"],
    ["no user verification when required", async () => ({ flags: FLAGS.UP }), 401, "MIU_E_AUTH_PASSKEY_FLAGS", { userVerification: "required" }],
    ["a userHandle of another user", async () => ({ userHandle: "b3RoZXI" }), 401, "MIU_E_AUTH_PASSKEY_INVALID"],
  ];
  for (const [name, arrange, status, code, cfg] of rejects) {
    test(`rejected: ${name} → ${status} ${code}, not signed in`, async () => {
      const { s, a } = await withPasskey(setup({ passkeys: cfg }));
      const r = await login(s, a, await arrange(a));
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe(code);
      expect(await me(s, r.jar)).toBe(401);
    });
  }

  test("RS256 with a bad signature is rejected", async () => {
    const { s, a } = await withPasskey(setup(), -257);
    const other = await newAuth(-257);
    const r = await login(s, a, { signWith: other.keys.privateKey });
    expect(r.status).toBe(401);
  });

  test("garbage assertions → 400/401, never 500", async () => {
    const { s, a } = await withPasskey();
    const opts = (await req(s, new Jar(), "POST", "/auth/passkeys/login/options", {})).body;
    const good = await a.get(opts, ORIGIN);
    for (const credential of [{}, { ...good, response: { ...good.response, signature: "!!" } }, { ...good, response: { ...good.response, authenticatorData: "AAAA" } }, 7]) {
      const r = await req(s, new Jar(), "POST", "/auth/passkeys/login/verify", { credential });
      expect([400, 401]).toContain(r.status);
    }
  });

  test("emailVerification required: an unverified user cannot sign in with a passkey", async () => {
    const users = memoryUserStore();
    const s = setup({ users });
    const { a } = await withPasskey(s);
    const strict = setup({ users, auth: { emailVerification: "required", mailer: { send: async () => {} }, appUrl: ORIGIN } });
    const r = await login(strict, a);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("MIU_E_AUTH_EMAIL_UNVERIFIED");
  });

  test("works end to end with dbUserStore", async () => {
    const { s, a } = await withPasskey(setup({ users: dbUserStore(sqlite()) }));
    expect((await login(s, a)).status).toBe(200);
    expect((await login(s, a)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------

describe("list and delete", () => {
  test("need sign-in", async () => {
    const s = setup();
    expect((await req(s, new Jar(), "GET", "/auth/passkeys")).status).toBe(401);
    expect((await req(s, new Jar(), "DELETE", "/auth/passkeys/x")).status).toBe(401);
  });

  test("you see and delete only your own; a deleted passkey no longer signs in", async () => {
    const { s, jar, a } = await withPasskey();
    const bob = await signedIn(s, "bob@example.com");
    expect((await req(s, bob, "GET", "/auth/passkeys")).body.passkeys).toEqual([]);
    const id = (await req(s, jar, "GET", "/auth/passkeys")).body.passkeys[0].id;
    expect((await req(s, bob, "DELETE", `/auth/passkeys/${id}`)).status).toBe(404);
    expect((await login(s, a)).status).toBe(200);
    expect((await req(s, jar, "DELETE", `/auth/passkeys/${id}`)).status).toBe(204);
    expect((await req(s, jar, "GET", "/auth/passkeys")).body.passkeys).toEqual([]);
    expect((await login(s, a)).status).toBe(401);
  });
});
