// OAuth 2.0 / OpenID Connect sign-in: authorization code + PKCE (S256), `state` bound to a short-lived
// signed cookie, `nonce` for OIDC, id_tokens verified against the provider's JWKS (from discovery).

import { errors, route, t, type Context, type Env, type RouteDef } from "miujs";
import { base64urlDecode, base64urlEncode, hex, randomBytes, randomId, sha256, sign, timingSafeEqual, unsign, utf8 } from "@miujs/session";
import { importEs256PrivateKey, signJwt, verifyJws, type JwsHeader } from "./jose.ts";
import { unusablePasswordHash } from "./password.ts";
import type { StoredUser, UserStore } from "./store.ts";

export interface OAuthClientOptions {
  clientId: string;
  /** Default: env `<PROVIDER>_CLIENT_SECRET`, e.g. `GOOGLE_CLIENT_SECRET`. */
  clientSecret?: string;
  /** Replaces the default scopes. */
  scopes?: string[];
}

/** Sign in with Apple. The client secret is an ES256 JWT that MiuJS makes from your key. */
export interface AppleOAuthOptions {
  /** The Services ID, e.g. `com.example.web`. */
  clientId: string;
  /** Your Apple Developer Team ID. */
  teamId: string;
  /** The Key ID of the Sign in with Apple key. */
  keyId: string;
  /** The `.p8` key (PKCS#8 PEM). Default: env `APPLE_PRIVATE_KEY`. */
  privateKey?: string;
  /** Default `["name", "email"]`. */
  scopes?: string[];
}

/** Any OpenID Connect provider (Okta, Auth0, Keycloak, Microsoft, ...), found through discovery. */
export interface OidcProviderOptions extends OAuthClientOptions {
  /** Route segment and stored provider name, e.g. `okta` → `/auth/oauth/okta`. */
  id: string;
  /** Exactly as the provider's discovery document states it, e.g. `https://example.okta.com`. */
  issuer: string;
  /** Default `"query"`. */
  responseMode?: "query" | "form_post";
}

export interface OAuthOptions {
  google?: OAuthClientOptions;
  github?: OAuthClientOptions;
  apple?: AppleOAuthOptions;
  discord?: OAuthClientOptions;
  oidc?: OidcProviderOptions[];
  /**
   * Signs the short-lived state cookie. Default: env `AUTH_SECRET`, then env `SESSION_SECRET`; in dev
   * only, a random per-process secret.
   */
  secret?: string;
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}

/** What auth() lends the OAuth routes. */
export interface OAuthDeps {
  base: string;
  users: UserStore;
  defaultRoles: string[];
  verification: "off" | "optional" | "required";
  isDev(): boolean;
  appUrlFor(ctx: Context): string;
  signIn(ctx: Context, user: StoredUser): void;
}

type Kind = "oidc" | "github" | "discord";

interface Provider {
  id: string;
  kind: Kind;
  issuer?: string;
  issuerAliases?: string[];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  clientId: string;
  scopes: string[];
  responseMode: "query" | "form_post";
  secret(env: Env): Promise<string>;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface Profile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

interface StatePayload {
  /** provider */
  p: string;
  /** state */
  s: string;
  /** PKCE verifier */
  v: string;
  /** nonce (OIDC) */
  n: string;
  /** returnTo */
  r: string;
  /** expires, epoch ms */
  e: number;
}

const COOKIE = "miu_oauth";
const STATE_TTL = 10 * 60_000;
const DISCOVERY_TTL = 3_600_000;
const JWKS_TTL = 3_600_000;
const JWKS_MISS_REFETCH = 60_000;
const SKEW = 60;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_RETURN_TO = 2048;
const MIN_SECRET = 32;

function oauthError(code: string, status: number, message: string, fix: string) {
  return errors.custom({ code: `MIU_E_AUTH_OAUTH_${code}`, status, message, fix });
}

const configError = (message: string, fix: string) => errors.config("MIU_E_AUTH_OAUTH_CONFIG", message, fix);

const stateError = (why: string) =>
  oauthError("STATE", 400, `OAuth sign-in could not be verified: ${why}`, "Start again from the sign-in button (GET /auth/oauth/:provider) in the same browser, and finish within 10 minutes. Cookies must be enabled.");

const idTokenError = (why: string) =>
  oauthError("ID_TOKEN", 401, `The provider's id_token was rejected: ${why}`, "Check the provider's clientId and issuer in auth({ oauth }); if they are right, start sign-in again.");

function isSecureUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

/** Only same-origin relative paths: `/x`, never `//host`, `/\host`, schemes or control characters. */
export function safeReturnTo(value: string | undefined): string | null {
  if (value === undefined || value === "") return "/";
  if (value.length > MAX_RETURN_TO) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  for (const v of [value, decoded]) {
    if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\") || /[\u0000-\u001f\u007f]/.test(v)) return null;
  }
  try {
    const u = new URL(value, "http://same.invalid");
    if (u.origin !== "http://same.invalid") return null;
  } catch {
    return null;
  }
  return value;
}

const envName = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`;

function clientSecretFor(id: string, given: string | undefined) {
  return async (env: Env) => {
    const s = given ?? (typeof env?.[envName(id)] === "string" ? (env[envName(id)] as string) : undefined);
    if (!s) {
      throw errors.config(
        "MIU_E_AUTH_OAUTH_CLIENT_SECRET_MISSING",
        `No client secret for the ${id} OAuth provider`,
        `Set the ${envName(id)} environment variable, or pass auth({ oauth: { ${id}: { clientSecret } } }).`,
      );
    }
    return s;
  };
}

function appleSecret(o: AppleOAuthOptions) {
  let cached: { jwt: string; exp: number } | null = null;
  let key: Promise<CryptoKey> | null = null;
  return async (env: Env) => {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - now > 3600) return cached.jwt;
    const pem = o.privateKey ?? (typeof env?.APPLE_PRIVATE_KEY === "string" ? (env.APPLE_PRIVATE_KEY as string) : undefined);
    if (!pem) {
      throw errors.config("MIU_E_AUTH_OAUTH_CLIENT_SECRET_MISSING", "No private key for Sign in with Apple", "Set APPLE_PRIVATE_KEY to the contents of the .p8 key file, or pass auth({ oauth: { apple: { privateKey } } }).");
    }
    key ??= importEs256PrivateKey(pem).catch((err) => {
      key = null;
      throw errors.config("MIU_E_AUTH_OAUTH_CONFIG", `The Apple private key could not be read (${(err as Error).message})`, "Use the .p8 file from Apple as-is: a PKCS#8 PEM starting with -----BEGIN PRIVATE KEY-----.");
    });
    const exp = now + 86_400;
    const jwt = await signJwt({ iss: o.teamId, iat: now, exp, aud: "https://appleid.apple.com", sub: o.clientId }, { kid: o.keyId }, await key);
    cached = { jwt, exp };
    return jwt;
  };
}

function buildProviders(o: OAuthOptions): Provider[] {
  const out: Provider[] = [];
  if (o.google) {
    out.push({
      id: "google",
      kind: "oidc",
      issuer: "https://accounts.google.com",
      issuerAliases: ["accounts.google.com"],
      clientId: o.google.clientId,
      scopes: o.google.scopes ?? ["openid", "email", "profile"],
      responseMode: "query",
      secret: clientSecretFor("google", o.google.clientSecret),
    });
  }
  if (o.github) {
    out.push({
      id: "github",
      kind: "github",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientId: o.github.clientId,
      scopes: o.github.scopes ?? ["read:user", "user:email"],
      responseMode: "query",
      secret: clientSecretFor("github", o.github.clientSecret),
    });
  }
  if (o.apple) {
    out.push({
      id: "apple",
      kind: "oidc",
      issuer: "https://appleid.apple.com",
      clientId: o.apple.clientId,
      scopes: o.apple.scopes ?? ["name", "email"],
      responseMode: "form_post",
      secret: appleSecret(o.apple),
    });
  }
  if (o.discord) {
    out.push({
      id: "discord",
      kind: "discord",
      authorizationEndpoint: "https://discord.com/oauth2/authorize",
      tokenEndpoint: "https://discord.com/api/oauth2/token",
      clientId: o.discord.clientId,
      scopes: o.discord.scopes ?? ["identify", "email"],
      responseMode: "query",
      secret: clientSecretFor("discord", o.discord.clientSecret),
    });
  }
  for (const p of o.oidc ?? []) {
    out.push({
      id: p.id,
      kind: "oidc",
      issuer: p.issuer,
      clientId: p.clientId,
      scopes: p.scopes ?? ["openid", "email", "profile"],
      responseMode: p.responseMode ?? "query",
      secret: clientSecretFor(p.id, p.clientSecret),
    });
  }
  return out;
}

/** Throws MIU_E_AUTH_OAUTH_CONFIG for anything that cannot work. */
function validate(o: OAuthOptions, providers: Provider[]) {
  const seen = new Set<string>();
  for (const p of providers) {
    if (!ID_RE.test(p.id)) throw configError(`OAuth provider id ${JSON.stringify(p.id)} is not valid`, "Use lowercase letters, digits, - and _ (max 32), e.g. { id: \"okta\" }.");
    if (seen.has(p.id)) throw configError(`OAuth provider "${p.id}" is configured twice`, "Give each oidc provider a unique id that is not google, github, apple or discord.");
    seen.add(p.id);
    if (typeof p.clientId !== "string" || !p.clientId) throw configError(`OAuth provider "${p.id}" has no clientId`, `Pass the client id from the provider's console: auth({ oauth: { ${p.id}: { clientId } } }).`);
    if (p.kind === "oidc" && !isSecureUrl(p.issuer)) throw configError(`OIDC issuer for "${p.id}" must be an https URL`, 'Use the issuer exactly as the provider publishes it, e.g. "https://example.okta.com".');
    if (p.kind === "oidc" && p.id !== "apple" && !p.scopes.includes("openid")) throw configError(`OIDC provider "${p.id}" needs the "openid" scope`, 'Add "openid" to scopes so the provider returns an id_token.');
  }
  if (o.apple && (!o.apple.teamId || !o.apple.keyId)) throw configError("Sign in with Apple needs teamId and keyId", "Pass auth({ oauth: { apple: { clientId, teamId, keyId, privateKey } } }) from your Apple Developer account.");
  if (o.secret !== undefined && o.secret.length < MIN_SECRET) throw configError(`oauth.secret is shorter than ${MIN_SECRET} characters`, "Use a random secret of 32+ characters, e.g. the output of `openssl rand -base64 48`.");
}

/** Store methods OAuth sign-in needs. */
export const OAUTH_STORE_METHODS = ["findOAuthAccount", "createOAuthAccount", "markEmailVerified", "changePassword", "deleteUserTokens", "deleteOneTimeTokens"] as const;

export function oauth(o: OAuthOptions, deps: OAuthDeps) {
  const providers = buildProviders(o);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const doFetch = (input: string, init: RequestInit): Promise<Response> => (o.fetch ?? fetch)(input, init);
  const users = deps.users as Required<Pick<UserStore, (typeof OAUTH_STORE_METHODS)[number]>> & UserStore;
  const cookiePath = `${deps.base}/oauth`;
  let devSecret: string | undefined;

  function stateSecret(ctx: Context): string {
    const env = ctx.env ?? {};
    const s = o.secret ?? (typeof env.AUTH_SECRET === "string" ? env.AUTH_SECRET : undefined) ?? (typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : undefined);
    if (s) {
      if (s.length < MIN_SECRET) throw configError("The OAuth state secret is shorter than 32 characters", "Set AUTH_SECRET (or SESSION_SECRET) to a random string of 32+ characters.");
      return s;
    }
    if (deps.isDev()) return (devSecret ??= randomId());
    throw errors.config(
      "MIU_E_AUTH_OAUTH_STATE_SECRET_MISSING",
      "No secret to sign the OAuth state cookie",
      "Set the SESSION_SECRET (or AUTH_SECRET) environment variable to a random string of 32+ characters, or pass auth({ oauth: { secret } }).",
    );
  }

  function provider(id: string): Provider {
    const p = byId.get(id);
    if (!p) throw oauthError("PROVIDER_UNKNOWN", 404, `No OAuth provider named ${JSON.stringify(id)}`, `Use one of: ${[...byId.keys()].join(", ")}. Add others in auth({ oauth }).`);
    return p;
  }

  // --- discovery and JWKS (cached per process) -------------------------------------------------

  const discoveries = new Map<string, { at: number; doc: Promise<Discovery> }>();
  const jwks = new Map<string, { at: number; missAt: number; keys: Promise<JsonWebKey[]> }>();

  async function getJson(url: string, init: RequestInit, fail: (why: string) => Error): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw fail(`request to ${url} failed (${(err as Error).message})`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw fail(`${url} did not return JSON (HTTP ${res.status})`);
    }
    if (!res.ok || !body || typeof body !== "object") {
      const e = (body as { error?: unknown })?.error;
      throw fail(`${url} answered HTTP ${res.status}${typeof e === "string" ? ` (${e.slice(0, 100)})` : ""}`);
    }
    return body as Record<string, unknown>;
  }

  const discoveryError = (p: Provider) => (why: string) =>
    oauthError("DISCOVERY", 502, `OpenID discovery for "${p.id}" failed: ${why}`, `Check that the issuer (${p.issuer}) is right and serves /.well-known/openid-configuration.`);

  function discover(p: Provider): Promise<Discovery> {
    const hit = discoveries.get(p.id);
    if (hit && Date.now() - hit.at < DISCOVERY_TTL) return hit.doc;
    const fail = discoveryError(p);
    const doc = (async () => {
      const d = await getJson(`${p.issuer!.replace(/\/+$/, "")}/.well-known/openid-configuration`, { headers: { accept: "application/json" } }, fail);
      // The document must describe the issuer we were configured with (OIDC Discovery §4.3).
      if (d.issuer !== p.issuer) throw fail(`it names issuer ${JSON.stringify(d.issuer)}, expected ${JSON.stringify(p.issuer)}`);
      for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        if (!isSecureUrl(d[k])) throw fail(`${k} is missing or not https`);
      }
      return d as unknown as Discovery;
    })();
    discoveries.set(p.id, { at: Date.now(), doc });
    doc.catch(() => discoveries.delete(p.id));
    return doc;
  }

  function fetchKeys(uri: string, p: Provider): Promise<JsonWebKey[]> {
    return getJson(uri, { headers: { accept: "application/json" } }, discoveryError(p)).then((b) => (Array.isArray(b.keys) ? (b.keys as JsonWebKey[]) : []));
  }

  async function keyFor(p: Provider, uri: string, header: JwsHeader): Promise<JsonWebKey | null> {
    const kty = header.alg === "RS256" ? "RSA" : "EC";
    const pick = (keys: JsonWebKey[]) => {
      const usable = keys.filter((k) => k && k.kty === kty);
      if (header.kid !== undefined) return usable.find((k) => (k as { kid?: string }).kid === header.kid) ?? null;
      return usable.length === 1 ? usable[0] : null;
    };
    const now = Date.now();
    let entry = jwks.get(uri);
    if (!entry || now - entry.at > JWKS_TTL) {
      entry = { at: now, missAt: 0, keys: fetchKeys(uri, p) };
      jwks.set(uri, entry);
      entry.keys.catch(() => jwks.delete(uri));
    }
    const found = pick(await entry.keys);
    if (found) return found;
    // Unknown kid: the provider may have rotated keys. Refetch, but at most once a minute so forged
    // tokens cannot make us hammer the provider.
    if (now - entry.missAt < JWKS_MISS_REFETCH) return null;
    const fresh = { at: now, missAt: now, keys: fetchKeys(uri, p) };
    jwks.set(uri, fresh);
    fresh.keys.catch(() => jwks.delete(uri));
    return pick(await fresh.keys);
  }

  // --- the state cookie ------------------------------------------------------------------------

  async function writeState(ctx: Context, p: Provider, payload: StatePayload) {
    const value = await sign(`oauth1.${base64urlEncode(utf8(JSON.stringify(payload)))}`, stateSecret(ctx));
    const local = ctx.url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(ctx.url.hostname);
    // form_post callbacks are cross-site POSTs: a Lax cookie would not be sent with them.
    const formPost = p.responseMode === "form_post";
    ctx.cookies.set(COOKIE, value, { maxAge: STATE_TTL / 1000, path: cookiePath, httpOnly: true, secure: formPost || !local, sameSite: formPost ? "None" : "Lax" });
  }

  async function readState(ctx: Context, p: Provider): Promise<StatePayload> {
    const raw = ctx.cookies.get(COOKIE);
    // One attempt per cookie, whatever happens next.
    ctx.cookies.delete(COOKIE, { path: cookiePath });
    if (!raw) throw stateError("the state cookie is missing");
    const value = await unsign(raw, [stateSecret(ctx)]);
    if (value === null || !value.startsWith("oauth1.")) throw stateError("the state cookie is invalid");
    let s: StatePayload;
    try {
      s = JSON.parse(new TextDecoder().decode(base64urlDecode(value.slice(7)) ?? new Uint8Array()));
    } catch {
      throw stateError("the state cookie is invalid");
    }
    if (!s || typeof s.s !== "string" || typeof s.v !== "string" || typeof s.n !== "string" || typeof s.r !== "string" || typeof s.e !== "number") throw stateError("the state cookie is invalid");
    if (s.e <= Date.now()) throw stateError("sign-in took too long");
    if (s.p !== p.id) throw stateError("it was started for another provider");
    return s;
  }

  // --- token exchange and profiles -------------------------------------------------------------

  const tokenError = (p: Provider) => (why: string) =>
    oauthError("TOKEN", 502, `Exchanging the code with "${p.id}" failed: ${why}`, `Check the ${p.id} clientId/clientSecret and that ${"`"}<appUrl>${deps.base}/oauth/${p.id}/callback${"`"} is registered as a redirect URI at the provider.`);

  async function exchange(ctx: Context, p: Provider, code: string, verifier: string, redirectUri: string, d: Discovery | null) {
    const secret = await p.secret(ctx.env);
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, client_id: p.clientId });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const methods = d?.token_endpoint_auth_methods_supported;
    if (methods && !methods.includes("client_secret_post") && methods.includes("client_secret_basic")) {
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
      headers.authorization = `Basic ${btoa(`${enc(p.clientId)}:${enc(secret)}`)}`;
    } else {
      form.set("client_secret", secret);
    }
    const body = await getJson(d?.token_endpoint ?? p.tokenEndpoint!, { method: "POST", headers, body: form.toString() }, tokenError(p));
    if (typeof body.error === "string") throw tokenError(p)(body.error.slice(0, 100));
    return body;
  }

  const truthy = (v: unknown) => v === true || v === "true";
  const cleanEmail = (v: unknown) => (typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null);
  const cleanName = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);

  async function oidcProfile(p: Provider, d: Discovery, token: Record<string, unknown>, nonce: string): Promise<Profile> {
    const idToken = token.id_token;
    if (typeof idToken !== "string") throw idTokenError("the token response has no id_token");
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await verifyJws(idToken, (h) => keyFor(p, d.jwks_uri, h)));
    } catch (err) {
      if ((err as { code?: string }).code) throw err;
      throw idTokenError((err as Error).message);
    }
    const now = Math.floor(Date.now() / 1000);
    const issuers = [p.issuer, ...(p.issuerAliases ?? [])];
    if (!issuers.includes(claims.iss as string)) throw idTokenError("wrong issuer");
    const aud = claims.aud;
    if (!(aud === p.clientId || (Array.isArray(aud) && aud.includes(p.clientId)))) throw idTokenError("it was issued for another client (aud)");
    if ((Array.isArray(aud) && aud.length > 1) || claims.azp !== undefined) {
      if (claims.azp !== p.clientId) throw idTokenError("it was issued for another client (azp)");
    }
    if (typeof claims.exp !== "number" || claims.exp <= now - SKEW) throw idTokenError("it has expired");
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + SKEW)) throw idTokenError("it is not valid yet");
    if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > now + 5 * SKEW)) throw idTokenError("it was issued in the future");
    if (typeof claims.nonce !== "string" || !timingSafeEqual(utf8(claims.nonce), utf8(nonce))) throw idTokenError("the nonce does not match this sign-in");
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw idTokenError("it has no subject");
    return { subject: claims.sub, email: cleanEmail(claims.email), emailVerified: truthy(claims.email_verified), name: cleanName(claims.name) };
  }

  async function githubProfile(p: Provider, token: Record<string, unknown>): Promise<Profile> {
    if (typeof token.access_token !== "string") throw tokenError(p)("no access_token in the response");
    const fail = (why: string) => oauthError("PROFILE", 502, `Reading the GitHub profile failed: ${why}`, "Check that the GitHub app requests the read:user and user:email scopes.");
    const headers = { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "miujs-auth", "x-github-api-version": "2022-11-28" };
    const user = await getJson("https://api.github.com/user", { headers }, fail);
    if (typeof user.id !== "number" && typeof user.id !== "string") throw fail("no user id");
    let email: string | null = null;
    let verified = false;
    try {
      const list = (await getJson("https://api.github.com/user/emails", { headers }, fail)) as unknown;
      const primary = Array.isArray(list) ? (list as { email?: unknown; primary?: unknown; verified?: unknown }[]).find((e) => e && e.primary === true) : undefined;
      if (primary) {
        email = cleanEmail(primary.email);
        verified = primary.verified === true;
      }
    } catch {
      // No user:email scope: treated as having no verified email.
    }
    if (!email) email = cleanEmail(user.email);
    return { subject: String(user.id), email, emailVerified: verified && email !== null, name: cleanName(user.name) ?? cleanName(user.login) };
  }

  async function discordProfile(p: Provider, token: Record<string, unknown>): Promise<Profile> {
    if (typeof token.access_token !== "string") throw tokenError(p)("no access_token in the response");
    const fail = (why: string) => oauthError("PROFILE", 502, `Reading the Discord profile failed: ${why}`, "Check that the Discord app requests the identify and email scopes.");
    const user = await getJson("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" } }, fail);
    if (typeof user.id !== "string" || !user.id) throw fail("no user id");
    const email = cleanEmail(user.email);
    return { subject: user.id, email, emailVerified: user.verified === true && email !== null, name: cleanName(user.global_name) ?? cleanName(user.username) };
  }

  // --- accounts --------------------------------------------------------------------------------

  /**
   * The account for this identity. Links to an existing user only when the provider vouches for the
   * email (verified) and it equals the user's email. Never links on an unverified email.
   */
  async function resolveUser(p: Provider, profile: Profile, env: Env, attempt = 0): Promise<StoredUser> {
    const linked = await users.findOAuthAccount(p.id, profile.subject, env);
    if (linked) {
      const u = await users.findUserById(linked.userId, env);
      if (u) return u;
    }
    const conflict = () => oauthError("CONFLICT", 409, "This account changed while signing in", "Start sign-in again.");
    const link = async (u: StoredUser) => {
      if (await users.createOAuthAccount({ id: randomId(12), provider: p.id, subject: profile.subject, userId: u.id, email: profile.email, createdAt: Date.now() }, env)) return u;
      if (attempt) throw conflict();
      return resolveUser(p, profile, env, attempt + 1);
    };
    const verified = profile.emailVerified && profile.email !== null;
    if (verified) {
      const existing = await users.findUserByEmail(profile.email!, env);
      if (existing) return link(existing.emailVerifiedAt == null ? await takeOver(existing, env) : existing);
    } else if (deps.verification === "required") {
      throw oauthError(
        "EMAIL_UNVERIFIED",
        403,
        `${p.id} did not confirm an email address for this account`,
        `Confirm your email address with ${p.id} (or make it your primary one) and sign in again, or register with email and password.`,
      );
    }
    // An unverified address is not stored as the user's email: it would block its real owner from
    // registering, and a later verified sign-in would link to this account.
    const email = verified ? profile.email! : `${p.id}-${hex(await sha256(`${p.id}:${profile.subject}`)).slice(0, 32)}@oauth.invalid`;
    const created = await users.createUser({ email, name: profile.name, roles: [...deps.defaultRoles], passwordHash: unusablePasswordHash() }, env);
    if (!created) {
      if (attempt) throw conflict();
      return resolveUser(p, profile, env, attempt + 1);
    }
    if (verified) {
      const at = Date.now();
      await users.markEmailVerified(created.id, at, env);
      created.emailVerifiedAt = at;
    }
    return link(created);
  }

  /**
   * The provider proved who owns this email, but the account's own email was never confirmed: whoever
   * made it may have been an attacker squatting the address (account pre-hijacking). Their password,
   * API tokens, passkeys and sessions are removed before the owner gets the account.
   */
  async function takeOver(u: StoredUser, env: Env): Promise<StoredUser> {
    const passwordHash = unusablePasswordHash();
    const sessionVersion = await users.changePassword(u.id, passwordHash, env);
    await users.deleteUserTokens(u.id, env);
    await users.deleteUserPasskeys?.(u.id, env);
    await users.deleteOneTimeTokens(u.id, "reset", env);
    await users.deleteOneTimeTokens(u.id, "verify", env);
    const at = Date.now();
    await users.markEmailVerified(u.id, at, env);
    return { ...u, passwordHash, sessionVersion, emailVerifiedAt: at };
  }

  // --- routes ----------------------------------------------------------------------------------

  const redirectUri = (ctx: Context, p: Provider) => `${deps.appUrlFor(ctx)}${deps.base}/oauth/${p.id}/callback`;

  const startRoute = route.get(`${deps.base}/oauth/:provider`, {
    name: "auth_oauth_start",
    summary: "Start signing in with an OAuth / OpenID Connect provider (redirects to it)",
    tags: ["auth"],
    mcp: false,
    params: t.object({ provider: t.string({ maxLength: 64 }) }),
    query: t.object({ returnTo: t.optional(t.string({ maxLength: 8192 })) }),
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const p = provider(ctx.params.provider);
      const returnTo = safeReturnTo(ctx.query.returnTo);
      if (returnTo === null) {
        throw oauthError("RETURN_TO", 400, "returnTo must be a path on this site", 'Pass a relative path such as "/dashboard" (starting with a single "/").');
      }
      const d = p.kind === "oidc" ? await discover(p) : null;
      const state = base64urlEncode(randomBytes(32));
      const verifier = base64urlEncode(randomBytes(32));
      const nonce = p.kind === "oidc" ? base64urlEncode(randomBytes(32)) : "";
      const url = new URL(d?.authorization_endpoint ?? p.authorizationEndpoint!);
      const q = url.searchParams;
      q.set("response_type", "code");
      q.set("client_id", p.clientId);
      q.set("redirect_uri", redirectUri(c, p));
      q.set("scope", p.scopes.join(" "));
      q.set("state", state);
      q.set("code_challenge", base64urlEncode(await sha256(verifier)));
      q.set("code_challenge_method", "S256");
      if (nonce) q.set("nonce", nonce);
      if (p.responseMode === "form_post") q.set("response_mode", "form_post");
      await writeState(c, p, { p: p.id, s: state, v: verifier, n: nonce, r: returnTo, e: Date.now() + STATE_TTL });
      return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
    },
  });

  const CallbackFields = {
    code: t.optional(t.string({ maxLength: 4096 })),
    state: t.optional(t.string({ maxLength: 512 })),
    error: t.optional(t.string({ maxLength: 256 })),
    error_description: t.optional(t.string({ maxLength: 2048 })),
  };

  async function finish(ctx: Context, providerId: string, input: { code?: string; state?: string; error?: string; user?: string }, viaPost: boolean) {
    const p = provider(providerId);
    if (viaPost && p.responseMode !== "form_post") throw errors.notFound("OAuth callback", `${providerId} (POST)`);
    const saved = await readState(ctx, p);
    if (typeof input.state !== "string" || !timingSafeEqual(utf8(input.state), utf8(saved.s))) throw stateError("the state does not match this browser's sign-in");
    if (input.error) {
      const reason = /^[a-z_]{1,64}$/.test(input.error) ? input.error : "error";
      throw oauthError("DENIED", 400, `${p.id} did not complete sign-in (${reason})`, "Try again and approve access at the provider.");
    }
    if (!input.code) throw stateError("the provider sent no code");
    const d = p.kind === "oidc" ? await discover(p) : null;
    const token = await exchange(ctx, p, input.code, saved.v, redirectUri(ctx, p), d);
    const profile = p.kind === "oidc" ? await oidcProfile(p, d!, token, saved.n) : p.kind === "github" ? await githubProfile(p, token) : await discordProfile(p, token);
    if (!profile.name && input.user) {
      // Apple sends the name once, as form data next to the code. It is only used as a display name.
      try {
        const n = (JSON.parse(input.user) as { name?: { firstName?: unknown; lastName?: unknown } }).name;
        profile.name = cleanName([n?.firstName, n?.lastName].filter((x) => typeof x === "string").join(" "));
      } catch {}
    }
    const user = await resolveUser(p, profile, ctx.env);
    if (deps.verification === "required" && user.emailVerifiedAt == null) {
      throw oauthError("EMAIL_UNVERIFIED", 403, "This account's email address is not confirmed", "Confirm your email address, or sign in with a provider that has confirmed it.");
    }
    deps.signIn(ctx, user);
    return new Response(null, { status: 302, headers: { location: saved.r, "cache-control": "no-store" } });
  }

  const callbackRoute = route.get(`${deps.base}/oauth/:provider/callback`, {
    name: "auth_oauth_callback",
    summary: "Finish OAuth / OpenID Connect sign-in (the provider redirects here)",
    tags: ["auth"],
    mcp: false,
    params: t.object({ provider: t.string({ maxLength: 64 }) }),
    query: t.object(CallbackFields),
    handler: (ctx) => finish(ctx as unknown as Context, ctx.params.provider, ctx.query, false),
  });

  const postCallbackRoute = route.post(`${deps.base}/oauth/:provider/callback`, {
    name: "auth_oauth_callback_post",
    summary: "Finish OAuth sign-in for providers that POST back (response_mode=form_post, e.g. Apple)",
    // A cross-site POST by design; the state + signed cookie check replaces the Origin check.
    tags: ["auth", "csrf-exempt"],
    mcp: false,
    params: t.object({ provider: t.string({ maxLength: 64 }) }),
    body: t.object({ ...CallbackFields, user: t.optional(t.string({ maxLength: 4096 })) }),
    handler: (ctx) => finish(ctx as unknown as Context, ctx.params.provider, ctx.body, true),
  });

  const routes: RouteDef[] = [startRoute, callbackRoute];
  if (providers.some((p) => p.responseMode === "form_post")) routes.push(postCallbackRoute);

  return {
    routes,
    providers: providers.map((p) => p.id),
    validate: () => validate(o, providers),
    inspect: () => ({ providers: providers.map((p) => ({ id: p.id, kind: p.kind, clientId: p.clientId, scopes: p.scopes, responseMode: p.responseMode })), secret: o.secret ? "(set)" : "env.AUTH_SECRET or env.SESSION_SECRET" }),
  };
}
