// Fake OAuth / OpenID providers for tests, served through an injected `fetch`. They enforce the
// protocol like real ones: single-use codes, PKCE S256, redirect_uri and client credentials.

import { base64urlEncode, utf8 } from "@miujs/session";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const b64json = (v: unknown) => base64urlEncode(utf8(JSON.stringify(v)));

export async function s256(verifier: string) {
  return base64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
}

export interface Grant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string | null;
  claims: Record<string, unknown>;
}

export type Handler = (req: Request, url: URL) => Promise<Response | null> | Response | null;

/** Routes requests by origin to fake providers and records every call. */
export function fakeFetch(...handlers: Handler[]) {
  const calls: { url: string; method: string; body: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === "GET" ? "" : await req.clone().text();
    calls.push({ url: req.url, method: req.method, body });
    const url = new URL(req.url);
    for (const h of handlers) {
      const res = await h(req, url);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export interface IdTokenOverrides {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  /** Sign with this key instead of the published one. */
  key?: CryptoKeyPair;
  /** Replace the signature with garbage. */
  badSignature?: boolean;
  /** Leave the id_token out of the token response. */
  omit?: boolean;
}

export async function fakeOidc(opts: { issuer: string; clientId: string; clientSecret?: string; alg?: "RS256" | "ES256"; clientSecretCheck?: (secret: string) => Promise<boolean> | boolean }) {
  const alg = opts.alg ?? "RS256";
  const gen = () =>
    alg === "RS256"
      ? (crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>)
      : (crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>);
  const state = {
    kid: "k1",
    keys: await gen(),
    grants: new Map<string, Grant>(),
    next: {} as IdTokenOverrides,
    tokenError: null as null | { status: number; body: unknown },
    lastTokenRequest: null as URLSearchParams | null,
    discoveryOverride: null as null | Record<string, unknown>,
  };
  const base = opts.issuer.replace(/\/+$/, "");

  async function sign(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey) {
    const input = `${b64json(header)}.${b64json(claims)}`;
    const params = alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" };
    const sig = new Uint8Array(await crypto.subtle.sign(params, key, utf8(input)));
    return `${input}.${base64urlEncode(sig)}`;
  }

  const idp = {
    issuer: opts.issuer,
    state,
    /** Rotate to a new signing key (new kid). */
    async rotate(kid = "k2") {
      state.kid = kid;
      state.keys = await gen();
    },
    /** What the user's browser does at the provider: approve and come back with a code. */
    authorize(authUrl: URL, claims: Record<string, unknown>): string {
      const p = authUrl.searchParams;
      const code = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      state.grants.set(code, { clientId: p.get("client_id")!, redirectUri: p.get("redirect_uri")!, codeChallenge: p.get("code_challenge")!, nonce: p.get("nonce"), claims });
      return code;
    },
    async handle(req: Request, url: URL): Promise<Response | null> {
      if (url.origin !== new URL(base).origin) return null;
      if (url.pathname === new URL(base).pathname.replace(/\/$/, "") + "/.well-known/openid-configuration") {
        return json(
          state.discoveryOverride ?? {
            issuer: opts.issuer,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            id_token_signing_alg_values_supported: [alg],
          },
        );
      }
      if (url.pathname.endsWith("/jwks")) {
        return json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", state.keys.publicKey)), kid: state.kid, use: "sig", alg }] });
      }
      if (url.pathname.endsWith("/token") && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        state.lastTokenRequest = form;
        if (state.tokenError) return json(state.tokenError.body, state.tokenError.status);
        const grant = state.grants.get(form.get("code") ?? "");
        state.grants.delete(form.get("code") ?? "");
        const secretOk = opts.clientSecretCheck ? await opts.clientSecretCheck(form.get("client_secret") ?? "") : form.get("client_secret") === opts.clientSecret;
        if (!grant || form.get("grant_type") !== "authorization_code" || form.get("client_id") !== opts.clientId || !secretOk) return json({ error: "invalid_grant" }, 400);
        if (form.get("redirect_uri") !== grant.redirectUri) return json({ error: "invalid_grant", error_description: "redirect_uri" }, 400);
        if ((await s256(form.get("code_verifier") ?? "")) !== grant.codeChallenge) return json({ error: "invalid_grant", error_description: "pkce" }, 400);
        const o = state.next;
        state.next = {};
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = { iss: opts.issuer, aud: opts.clientId, iat: now, exp: now + 600, ...(grant.nonce ? { nonce: grant.nonce } : {}), ...grant.claims, ...o.claims };
        for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
        let token = await sign({ alg, kid: state.kid, typ: "JWT", ...o.header }, claims, (o.key ?? state.keys).privateKey);
        if (o.badSignature) token = token.slice(0, token.lastIndexOf(".") + 1) + base64urlEncode(crypto.getRandomValues(new Uint8Array(alg === "RS256" ? 256 : 64)));
        return json({ access_token: "at-" + base64urlEncode(crypto.getRandomValues(new Uint8Array(8))), token_type: "Bearer", ...(o.omit ? {} : { id_token: token }) });
      }
      return null;
    },
    /** Builds an unsigned `alg: none` token with the given claims. */
    none(claims: Record<string, unknown>) {
      return `${b64json({ alg: "none" })}.${b64json(claims)}.`;
    },
    sign,
  };
  return idp;
}

/** GitHub: OAuth only (no id_token); profile and emails from the REST API. */
export function fakeGithub(opts: { clientId: string; clientSecret: string }) {
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, { user: Record<string, unknown>; emails: unknown[] }>();
  const state = { tokenOkButError: false, lastTokenRequest: null as URLSearchParams | null, apiCalls: [] as { path: string; auth: string | null; ua: string | null }[] };
  return {
    state,
    authorize(authUrl: URL, profile: { user: Record<string, unknown>; emails: unknown[] }): string {
      const p = authUrl.searchParams;
      const code = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      grants.set(code, { clientId: p.get("client_id")!, redirectUri: p.get("redirect_uri")!, codeChallenge: p.get("code_challenge")!, nonce: null, claims: profile as never });
      return code;
    },
    async handle(req: Request, url: URL): Promise<Response | null> {
      if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        state.lastTokenRequest = form;
        // GitHub answers errors with 200 and an `error` field.
        if (state.tokenOkButError) return json({ error: "bad_verification_code" });
        const g = grants.get(form.get("code") ?? "");
        grants.delete(form.get("code") ?? "");
        if (!g || form.get("client_id") !== opts.clientId || form.get("client_secret") !== opts.clientSecret || form.get("redirect_uri") !== g.redirectUri) return json({ error: "bad_verification_code" });
        if ((await s256(form.get("code_verifier") ?? "")) !== g.codeChallenge) return json({ error: "bad_verification_code" });
        const token = "gho_" + base64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
        tokens.set(token, g.claims as never);
        return json({ access_token: token, token_type: "bearer", scope: "read:user,user:email" });
      }
      if (url.origin === "https://api.github.com") {
        const auth = req.headers.get("authorization");
        state.apiCalls.push({ path: url.pathname, auth, ua: req.headers.get("user-agent") });
        const t = tokens.get((auth ?? "").replace(/^Bearer /, ""));
        if (!t) return json({ message: "Bad credentials" }, 401);
        if (url.pathname === "/user") return json(t.user);
        if (url.pathname === "/user/emails") return json(t.emails);
      }
      return null;
    },
  };
}

/** Discord: OAuth only; profile from /users/@me with a `verified` flag. */
export function fakeDiscord(opts: { clientId: string; clientSecret: string }) {
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, Record<string, unknown>>();
  return {
    authorize(authUrl: URL, user: Record<string, unknown>): string {
      const p = authUrl.searchParams;
      const code = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      grants.set(code, { clientId: p.get("client_id")!, redirectUri: p.get("redirect_uri")!, codeChallenge: p.get("code_challenge")!, nonce: null, claims: user });
      return code;
    },
    async handle(req: Request, url: URL): Promise<Response | null> {
      if (url.origin !== "https://discord.com") return null;
      if (url.pathname === "/api/oauth2/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const g = grants.get(form.get("code") ?? "");
        grants.delete(form.get("code") ?? "");
        if (!g || form.get("client_id") !== opts.clientId || form.get("client_secret") !== opts.clientSecret) return json({ error: "invalid_grant" }, 400);
        if ((await s256(form.get("code_verifier") ?? "")) !== g.codeChallenge) return json({ error: "invalid_grant" }, 400);
        const token = "dc_" + base64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
        tokens.set(token, g.claims);
        return json({ access_token: token, token_type: "Bearer" });
      }
      if (url.pathname === "/api/users/@me") {
        const t = tokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
        return t ? json(t) : json({ message: "401: Unauthorized" }, 401);
      }
      return null;
    },
  };
}
