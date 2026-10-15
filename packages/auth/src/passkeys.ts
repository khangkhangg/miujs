// Passkeys (WebAuthn Level 2/3): registration and sign-in. ES256 and RS256, attestation "none"
// (packed statements are accepted but not verified), single-use server-side challenges.

import { errors, route, t, type AuthUser, type Context, type Env, type MiuError, type RouteDef } from "miujs";
import { base64urlDecode, base64urlEncode, randomBytes, sha256, timingSafeEqual, utf8 } from "@miujs/session";
import { decodeCbor, decodeCborPrefix, type CborValue } from "./cbor.ts";
import { derToRawSignature, importVerifyKey, verifySignature, type JwsAlgorithm } from "./jose.ts";
import type { PasskeyRecord, StoredUser, UserStore } from "./store.ts";

export interface PasskeyOptions {
  /** Relying party id: your registrable domain, e.g. `example.com` (no scheme or port). */
  rpId: string;
  /** Shown by the browser/OS, e.g. your app's name. */
  rpName: string;
  /** Exact origins allowed to use passkeys, e.g. `["https://example.com"]`. Each must be on `rpId` or a subdomain. */
  origins: string[];
  /**
   * `"required"`: the UV flag (PIN/biometric) must be set. `"preferred"` (default) / `"discouraged"`:
   * user presence is enough.
   */
  userVerification?: "required" | "preferred" | "discouraged";
}

export interface PasskeyDeps {
  base: string;
  users: UserStore;
  verification: "off" | "optional" | "required";
  signIn(ctx: Context, user: StoredUser): void;
  publicUser(user: StoredUser): AuthUser;
  emailUnverified(): MiuError;
  /** Counts a sign-in attempt; returns a 429 Response when over the limit. */
  limit(ctx: Context): Promise<Response | null>;
}

/** Store methods passkeys need. */
export const PASSKEY_STORE_METHODS = ["createPasskey", "findPasskeyByCredentialId", "listPasskeys", "deletePasskey", "updatePasskeyUsage", "createChallenge", "consumeChallenge"] as const;

const CHALLENGE_TTL = 5 * 60_000;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
const ALGS: Record<number, JwsAlgorithm> = { [-7]: "ES256", [-257]: "RS256" };
const MAX_FIELD = 64 * 1024;

type Phase = "register" | "login";

function pkError(code: string, status: number, message: string, fix: string) {
  return errors.custom({ code: `MIU_E_AUTH_PASSKEY_${code}`, status, message, fix });
}

const invalid = (why: string, status = 400) => pkError("INVALID", status, `Passkey response rejected: ${why}`, "Send the credential exactly as the browser returned it (credential.toJSON()), for options you just requested.");
const challengeError = (phase: Phase) =>
  pkError("CHALLENGE", 400, "The passkey challenge is unknown, already used or expired", `Request new options with POST /auth/passkeys/${phase}/options and finish within 5 minutes. Each challenge works once.`);

function configError(message: string, fix: string) {
  return errors.config("MIU_E_AUTH_PASSKEY_CONFIG", message, fix);
}

function bytes(v: unknown, what: string, max = MAX_FIELD): Uint8Array {
  if (typeof v !== "string" || v.length > max) throw invalid(`${what} is missing`);
  const b = base64urlDecode(v.replace(/=+$/, ""));
  if (!b) throw invalid(`${what} is not base64url`);
  return b;
}

interface ClientData {
  challenge: string;
  origin: string;
  crossOrigin?: unknown;
}

function clientData(raw: Uint8Array, type: string): ClientData {
  let cd: Record<string, unknown>;
  try {
    cd = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw invalid("clientDataJSON is not JSON");
  }
  if (!cd || typeof cd !== "object") throw invalid("clientDataJSON is not an object");
  if (cd.type !== type) throw invalid(`clientDataJSON.type is ${JSON.stringify(cd.type)}, expected ${type}`);
  if (typeof cd.challenge !== "string" || typeof cd.origin !== "string") throw invalid("clientDataJSON lacks challenge or origin");
  return cd as unknown as ClientData;
}

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: CborValue;
}

function authData(ad: Uint8Array): AuthData {
  if (ad.length < 37) throw invalid("authenticatorData is too short");
  const flags = ad[32];
  const signCount = new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0);
  const out: AuthData = { rpIdHash: ad.subarray(0, 32), flags, signCount };
  let pos = 37;
  try {
    if (flags & FLAG_AT) {
      if (ad.length < pos + 18) throw new Error("short");
      const len = (ad[pos + 16] << 8) | ad[pos + 17];
      pos += 18;
      if (len < 1 || len > 1023 || pos + len > ad.length) throw new Error("bad credential id length");
      out.credentialId = ad.slice(pos, pos + len);
      pos += len;
      const key = decodeCborPrefix(ad.subarray(pos));
      out.publicKey = key.value;
      pos += key.length;
    }
    if (flags & FLAG_ED) pos += decodeCborPrefix(ad.subarray(pos)).length;
  } catch {
    throw invalid("authenticatorData is malformed");
  }
  if (pos !== ad.length) throw invalid("authenticatorData has trailing bytes");
  return out;
}

/** COSE_Key → JWK, for ES256 (EC2, P-256) and RS256 (RSA ≥ 2048 bits) only. */
async function coseToJwk(cose: CborValue): Promise<{ jwk: JsonWebKey; alg: number }> {
  if (!(cose instanceof Map)) throw invalid("the credential public key is not a COSE key");
  const alg = cose.get(3);
  if (typeof alg !== "number" || !(alg in ALGS)) {
    throw pkError("ALGORITHM", 400, `Passkey algorithm ${String(alg)} is not supported`, "Offer ES256 (-7) or RS256 (-257): use pubKeyCredParams from /auth/passkeys/register/options as-is.");
  }
  const b64 = (v: CborValue) => base64urlEncode(v as Uint8Array);
  let jwk: JsonWebKey;
  if (alg === -7) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (cose.get(1) !== 2 || cose.get(-1) !== 1 || !(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) throw invalid("the ES256 key is not a P-256 EC2 key");
    jwk = { kty: "EC", crv: "P-256", x: b64(x), y: b64(y) };
  } else {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (cose.get(1) !== 3 || !(n instanceof Uint8Array) || n.length < 256 || n.length > 1024 || !(e instanceof Uint8Array) || e.length < 1 || e.length > 8) throw invalid("the RS256 key is not an RSA key of 2048+ bits");
    jwk = { kty: "RSA", n: b64(n), e: b64(e) };
  }
  try {
    await importVerifyKey(jwk, ALGS[alg]);
  } catch {
    throw invalid("the credential public key is not a valid key");
  }
  return { jwk, alg };
}

const userHandle = (userId: string) => base64urlEncode(utf8(userId));

function shape(v: unknown, fields: string[]): { id: string; raw: Uint8Array; response: Record<string, unknown> } {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("credential must be an object");
  const c = v as Record<string, unknown>;
  if (c.type !== "public-key") throw invalid('credential.type must be "public-key"');
  const raw = bytes(c.rawId, "rawId", 2048);
  if (typeof c.id !== "string" || !timingSafeEqual(bytes(c.id, "id", 2048), raw)) throw invalid("credential id and rawId differ");
  if (!c.response || typeof c.response !== "object") throw invalid("credential.response is missing");
  const response = c.response as Record<string, unknown>;
  for (const f of fields) if (typeof response[f] !== "string") throw invalid(`response.${f} is missing`);
  return { id: base64urlEncode(raw), raw, response };
}

export function passkeys(o: PasskeyOptions, deps: PasskeyDeps) {
  const users = deps.users as Required<Pick<UserStore, (typeof PASSKEY_STORE_METHODS)[number]>> & UserStore;
  const uv = o.userVerification ?? "preferred";
  const origins = new Set(o.origins);
  const base = `${deps.base}/passkeys`;
  let rpIdHash: Promise<Uint8Array> | undefined;

  function checkOrigin(cd: ClientData) {
    if (!origins.has(cd.origin) || cd.crossOrigin === true) {
      throw pkError("ORIGIN", 400, `Passkey used from an origin that is not allowed (${cd.origin.slice(0, 200)})`, `Add the site's origin to auth({ passkeys: { origins } }). Allowed now: ${[...origins].join(", ")}. Cross-origin iframes are refused.`);
    }
  }

  async function checkAuthenticator(ad: AuthData, status: number) {
    if (!timingSafeEqual(ad.rpIdHash, await (rpIdHash ??= sha256(o.rpId)))) {
      throw pkError("RP_ID", 400, "The passkey was made for another site (rpIdHash mismatch)", `Use rp.id / rpId exactly as returned by the options route ("${o.rpId}").`);
    }
    if (!(ad.flags & FLAG_UP)) throw pkError("FLAGS", status, "The authenticator did not confirm user presence", "Touch or confirm on the authenticator when the browser asks.");
    if (uv === "required" && !(ad.flags & FLAG_UV)) {
      throw pkError("FLAGS", status, "The authenticator did not verify the user (PIN or biometric)", 'Use an authenticator with a PIN or biometric, or set auth({ passkeys: { userVerification: "preferred" } }).');
    }
  }

  async function takeChallenge(ctx: { env: Env }, cd: ClientData, phase: Phase, userId: string | null) {
    const rec = await users.consumeChallenge(cd.challenge, phase === "register" ? "passkey-register" : "passkey-login", ctx.env);
    if (!rec || rec.expiresAt <= Date.now() || rec.userId !== userId) throw challengeError(phase);
  }

  async function newChallenge(ctx: { env: Env }, phase: Phase, userId: string | null): Promise<string> {
    const challenge = base64urlEncode(randomBytes(32));
    const now = Date.now();
    await users.createChallenge({ challenge, purpose: phase === "register" ? "passkey-register" : "passkey-login", userId, createdAt: now, expiresAt: now + CHALLENGE_TTL }, ctx.env);
    return challenge;
  }

  function sessionOnly(ctx: Context) {
    // An API token must not be able to mint a sign-in credential for the browser.
    if (ctx.state.authMethod !== "session") {
      throw pkError("SESSION_REQUIRED", 403, "Passkeys can only be added from a signed-in browser session", "Sign in with a password (or an existing passkey) in the browser, then add the passkey there; API tokens cannot add passkeys.");
    }
  }

  const tags = ["auth", "csrf-always"];

  const registerOptions = route.post(`${base}/register/options`, {
    name: "auth_passkey_register_options",
    summary: "Start adding a passkey to your account (returns WebAuthn creation options)",
    tags,
    mcp: false,
    auth: "required",
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      sessionOnly(c);
      const user = await users.findUserById(ctx.user.id, ctx.env);
      if (!user) throw errors.unauthorized();
      const challenge = await newChallenge(ctx, "register", user.id);
      const existing = await users.listPasskeys(user.id, ctx.env);
      return {
        rp: { id: o.rpId, name: o.rpName },
        user: { id: userHandle(user.id), name: user.email, displayName: user.name ?? user.email },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: CHALLENGE_TTL,
        attestation: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: uv },
        excludeCredentials: existing.map((p) => ({ type: "public-key", id: p.credentialId, transports: p.transports })),
      };
    },
  });

  const registerVerify = route.post(`${base}/register/verify`, {
    name: "auth_passkey_register_verify",
    summary: "Finish adding a passkey with the browser's registration response",
    tags,
    mcp: false,
    auth: "required",
    status: 201,
    body: t.object({ credential: t.unknown(), name: t.optional(t.string({ maxLength: 100 })) }),
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      sessionOnly(c);
      const cred = shape(ctx.body.credential, ["clientDataJSON", "attestationObject"]);
      const cd = clientData(bytes(cred.response.clientDataJSON, "clientDataJSON"), "webauthn.create");
      checkOrigin(cd);
      let att: CborValue;
      try {
        att = decodeCbor(bytes(cred.response.attestationObject, "attestationObject"));
      } catch {
        throw invalid("attestationObject is not valid CBOR");
      }
      if (!(att instanceof Map) || !(att.get("authData") instanceof Uint8Array) || typeof att.get("fmt") !== "string" || !(att.get("attStmt") instanceof Map)) throw invalid("attestationObject is malformed");
      const fmt = att.get("fmt") as string;
      // We ask for attestation "none". "packed" (self attestation) is accepted and its statement ignored:
      // nothing here claims to know what kind of authenticator this is.
      if (!(fmt === "none" && (att.get("attStmt") as Map<unknown, unknown>).size === 0) && fmt !== "packed") {
        throw pkError("ATTESTATION", 400, `Attestation format ${JSON.stringify(fmt)} is not accepted`, 'Request options from /auth/passkeys/register/options (attestation: "none") and pass them to navigator.credentials.create() unchanged.');
      }
      const ad = authData(att.get("authData") as Uint8Array);
      await takeChallenge(ctx, cd, "register", ctx.user.id);
      await checkAuthenticator(ad, 400);
      if (!ad.credentialId || ad.publicKey === undefined) throw invalid("authenticatorData has no attested credential");
      if (!timingSafeEqual(ad.credentialId, cred.raw)) throw invalid("the credential id in authenticatorData differs from rawId");
      const { jwk, alg } = await coseToJwk(ad.publicKey);
      const transports = Array.isArray(cred.response.transports) ? (cred.response.transports as unknown[]).filter((x): x is string => typeof x === "string" && x.length <= 32).slice(0, 10) : [];
      const now = Date.now();
      const rec: PasskeyRecord = {
        id: base64urlEncode(randomBytes(12)),
        userId: ctx.user.id,
        credentialId: cred.id,
        publicKey: jwk,
        algorithm: alg,
        signCount: ad.signCount,
        transports,
        name: ctx.body.name?.trim() || null,
        createdAt: now,
        lastUsedAt: null,
      };
      if (!(await users.createPasskey(rec, ctx.env))) {
        throw pkError("EXISTS", 409, "This passkey is already registered", "Use it to sign in, or remove it first with DELETE /auth/passkeys/:id.");
      }
      return { passkey: { id: rec.id, name: rec.name, createdAt: rec.createdAt } };
    },
  });

  const loginOptions = route.post(`${base}/login/options`, {
    name: "auth_passkey_login_options",
    summary: "Start signing in with a passkey (returns WebAuthn request options)",
    tags,
    mcp: false,
    handler: async (ctx) => {
      const blocked = await deps.limit(ctx as unknown as Context);
      if (blocked) return blocked;
      // Discoverable credentials: no allowCredentials, so the response says nothing about accounts.
      return { challenge: await newChallenge(ctx, "login", null), rpId: o.rpId, timeout: CHALLENGE_TTL, userVerification: uv, allowCredentials: [] };
    },
  });

  const loginVerify = route.post(`${base}/login/verify`, {
    name: "auth_passkey_login_verify",
    summary: "Finish signing in with the browser's passkey assertion",
    tags,
    mcp: false,
    body: t.object({ credential: t.unknown() }),
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const blocked = await deps.limit(c);
      if (blocked) return blocked;
      const cred = shape(ctx.body.credential, ["clientDataJSON", "authenticatorData", "signature"]);
      const cdRaw = bytes(cred.response.clientDataJSON, "clientDataJSON");
      const adRaw = bytes(cred.response.authenticatorData, "authenticatorData");
      const signature = bytes(cred.response.signature, "signature");
      const handle = cred.response.userHandle;
      if (handle !== undefined && handle !== null && typeof handle !== "string") throw invalid("userHandle must be a string");
      const cd = clientData(cdRaw, "webauthn.get");
      checkOrigin(cd);
      const ad = authData(adRaw);
      await takeChallenge(ctx, cd, "login", null);
      await checkAuthenticator(ad, 401);
      const failed = () => invalid("the passkey could not be verified", 401);
      const pk = await users.findPasskeyByCredentialId(cred.id, ctx.env);
      if (!pk) throw failed();
      if (typeof handle === "string" && handle !== "" && handle !== userHandle(pk.userId)) throw failed();
      const alg = ALGS[pk.algorithm];
      if (!alg) throw failed();
      const sig = alg === "ES256" ? derToRawSignature(signature) : signature;
      if (!sig) throw failed();
      const data = new Uint8Array(adRaw.length + 32);
      data.set(adRaw);
      data.set(await sha256(cdRaw), adRaw.length);
      if (!(await verifySignature(alg, await importVerifyKey(pk.publicKey, alg), sig, data))) throw failed();
      // Signature counters only go up. A counter that did not (when either side is non-zero) means
      // two copies of the key exist: refuse, as WebAuthn §6.1.1 suggests.
      const cloned = () => pkError("CLONED", 401, "This passkey's signature counter went backwards; it may have been copied", "Remove this passkey (DELETE /auth/passkeys/:id) from a signed-in session and register a new one.");
      if ((ad.signCount !== 0 || pk.signCount !== 0) && ad.signCount <= pk.signCount) throw cloned();
      if (!(await users.updatePasskeyUsage(pk.id, pk.signCount, ad.signCount, Date.now(), ctx.env))) throw cloned();
      const user = await users.findUserById(pk.userId, ctx.env);
      if (!user) throw failed();
      if (deps.verification === "required" && user.emailVerifiedAt == null) throw deps.emailUnverified();
      deps.signIn(c, user);
      return { user: deps.publicUser(user) };
    },
  });

  const listRoute = route.get(base, {
    name: "auth_passkey_list",
    summary: "List your passkeys",
    tags: ["auth"],
    mcp: false,
    auth: "required",
    handler: async (ctx) => {
      const list = await users.listPasskeys(ctx.user.id, ctx.env);
      return { passkeys: list.map((p) => ({ id: p.id, name: p.name, transports: p.transports, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) };
    },
  });

  const deleteRoute = route.delete(`${base}/:id`, {
    name: "auth_passkey_delete",
    summary: "Remove one of your passkeys",
    tags: ["auth"],
    mcp: false,
    auth: "required",
    params: t.object({ id: t.string({ maxLength: 100 }) }),
    handler: async (ctx) => {
      if (!(await users.deletePasskey(ctx.params.id, ctx.user.id, ctx.env))) throw errors.notFound("Passkey", ctx.params.id);
    },
  });

  function validate() {
    if (typeof o.rpName !== "string" || !o.rpName.trim()) throw configError("passkeys.rpName is empty", "Pass your app's name: auth({ passkeys: { rpName: \"Example\" } }).");
    if (typeof o.rpId !== "string" || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(o.rpId)) {
      throw configError(`passkeys.rpId ${JSON.stringify(o.rpId)} is not a domain`, 'Use your site\'s lowercase domain without scheme or port, e.g. rpId: "example.com".');
    }
    if (!Array.isArray(o.origins) || o.origins.length === 0) throw configError("passkeys.origins is empty", `List the exact origins that use passkeys, e.g. origins: ["https://${o.rpId}"].`);
    for (const origin of o.origins) {
      let u: URL | null = null;
      try {
        u = new URL(origin);
      } catch {}
      const local = u?.protocol === "http:" && u.hostname === "localhost";
      if (!u || u.origin !== origin || (u.protocol !== "https:" && !local)) {
        throw configError(`passkeys origin ${JSON.stringify(origin)} is not an https origin`, 'Use the exact origin, like "https://example.com" (no path); http is allowed only for localhost.');
      }
      if (u.hostname !== o.rpId && !u.hostname.endsWith(`.${o.rpId}`)) {
        throw configError(`passkeys origin ${origin} is not on rpId ${o.rpId}`, `Each origin must be ${o.rpId} or a subdomain of it; set rpId to the shared parent domain.`);
      }
    }
    if (!["required", "preferred", "discouraged"].includes(uv)) throw configError(`passkeys.userVerification ${JSON.stringify(uv)} is not valid`, 'Use "required", "preferred" or "discouraged".');
  }

  const routes: RouteDef[] = [registerOptions, registerVerify, loginOptions, loginVerify, listRoute, deleteRoute];
  return { routes, validate, inspect: () => ({ rpId: o.rpId, rpName: o.rpName, origins: [...origins], userVerification: uv }) };
}
