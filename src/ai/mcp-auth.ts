import type { Middleware } from "../core/app.ts";
import type { Context } from "../core/context.ts";
import { HttpError, problem } from "../core/errors.ts";
import {
  verifyJwt,
  type JsonWebKeySet,
  type JwksResolver,
  type JwtAlgorithm,
  type JwtKey,
  type JwtPayload,
} from "../batteries/auth/jwt.ts";

/**
 * MCP authorization (spec 2025-06-18): the MCP server is an OAuth 2.1 protected resource.
 * - serves RFC 9728 metadata at `/.well-known/oauth-protected-resource[/<path>]`;
 * - answers unauthenticated MCP requests with `401` + `WWW-Authenticate: Bearer resource_metadata="…"`
 *   so clients can discover the authorization server;
 * - requires tokens issued for this resource (audience binding, RFC 8707) and, optionally, scopes;
 * - exposes the token's user as `c.get("user")`.
 *
 * Install it before `mcp()`:  `app.use(mcpAuth({...})).use(mcp())`. If you also use `auth()`, put
 * `mcpAuth()` after it, since `auth()` always overwrites `user`.
 *
 * Tool calls re-enter the app as ordinary requests carrying the forwarded `Authorization` header;
 * with `authenticateRoutes` (default) this middleware authenticates those too, so routes run as the
 * token's user and `requireAuth()` / per-route checks apply to agents exactly as to people.
 */

export interface McpAuthInfo<U = unknown> {
  /** The authenticated principal, exposed as `c.get("user")`. */
  user: U;
  /** Audience(s) the token was issued for (JWT `aud`, or `aud` from token introspection). */
  audience: string | string[] | undefined;
  /** Granted scopes. */
  scopes?: string[];
}

export interface McpAuthOptions<U = unknown> {
  /** Canonical URI of this MCP server, e.g. `https://api.example.com/mcp`. Tokens must be issued for it. */
  resource: string;
  /** Issuer URLs of the authorization server(s) clients should use. */
  authorizationServers: string[];
  /** Advertised in the metadata. */
  scopesSupported?: string[];
  /** Scopes every MCP request needs; missing ones get `403 insufficient_scope`. */
  requiredScopes?: string[];
  /** Additional accepted audiences besides `resource` (e.g. an `api://` identifier). */
  audiences?: string[];
  /**
   * Validate a bearer token. Return undefined (or throw a 401 `HttpError`) when invalid.
   * Other errors propagate (e.g. a 503 when the JWKS is unreachable). See `mcpJwtVerifier`.
   */
  verify: (token: string, c: Context<any, any>) => Promise<McpAuthInfo<U> | undefined>;
  /** MCP endpoint path. Default `/mcp` (same as `mcp()`). */
  path?: string;
  /** Also authenticate bearer tokens on other routes (needed for tool calls to run as the user). Default true. */
  authenticateRoutes?: boolean;
  resourceName?: string;
  resourceDocumentation?: string;
}

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

export function mcpAuth<U = unknown>(opts: McpAuthOptions<U>): Middleware {
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(opts.resource);
  } catch {
    throw new TypeError(`mcpAuth: resource must be an absolute URL, got ${JSON.stringify(opts.resource)}`);
  }
  if (opts.resource.includes("#")) throw new TypeError("mcpAuth: resource must not contain a fragment");
  if (!opts.authorizationServers?.length) throw new TypeError("mcpAuth: authorizationServers must list at least one issuer");

  const path = opts.path ?? "/mcp";
  const resourcePath = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname.replace(/\/+$/, "");
  const metadataPaths = new Set([WELL_KNOWN, WELL_KNOWN + resourcePath]);
  // Built from configuration only: never from the request's Host header.
  const metadataUrl = `${resourceUrl.origin}${WELL_KNOWN}${resourcePath}`;
  const accepted = new Set([opts.resource, ...(opts.audiences ?? [])].map(normalizeAudience));
  const required = opts.requiredScopes ?? [];
  const authenticateRoutes = opts.authenticateRoutes ?? true;

  const metadata: Record<string, unknown> = {
    resource: opts.resource,
    authorization_servers: opts.authorizationServers,
  };
  if (opts.scopesSupported) metadata.scopes_supported = opts.scopesSupported;
  metadata.bearer_methods_supported = ["header"];
  if (opts.resourceName) metadata.resource_name = opts.resourceName;
  if (opts.resourceDocumentation) metadata.resource_documentation = opts.resourceDocumentation;
  const metadataJson = JSON.stringify(metadata);

  const challenge = (status: 401 | 403, params: string[], code: string, detail: string) =>
    problem(status, { code, detail }, { "www-authenticate": `Bearer ${[...params, `resource_metadata="${metadataUrl}"`].join(", ")}` });

  /** Verify and bind a token: info on success, or an error description. */
  const check = async (token: string, c: Context<any, any>): Promise<McpAuthInfo<U> | string> => {
    let info: McpAuthInfo<U> | undefined;
    try {
      info = await opts.verify(token, c);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) return e.message;
      throw e;
    }
    if (!info) return "Invalid access token";
    const aud = info.audience === undefined ? [] : Array.isArray(info.audience) ? info.audience : [info.audience];
    if (!aud.some((a) => typeof a === "string" && accepted.has(normalizeAudience(a)))) {
      return "Token was not issued for this resource";
    }
    return info;
  };

  return async (c, next) => {
    const pathname = c.url.pathname;
    if (metadataPaths.has(pathname) && (c.method === "GET" || c.method === "HEAD")) {
      return new Response(c.method === "HEAD" ? null : metadataJson, {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    const m = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(c.req.headers.get("authorization") ?? "");
    if (pathname !== path) {
      if (authenticateRoutes && m) {
        const r = await check(m[1]!, c);
        if (typeof r !== "string") setAuth(c, r);
      }
      return next();
    }

    if (c.method === "OPTIONS") return next(); // CORS preflight carries no credentials
    if (!m) {
      return challenge(401, [], "unauthenticated", "This MCP server requires an OAuth access token. See resource_metadata in WWW-Authenticate.");
    }
    const r = await check(m[1]!, c);
    if (typeof r === "string") return challenge(401, ['error="invalid_token"', `error_description="${quote(r)}"`], "invalid_token", r);
    const granted = new Set(r.scopes ?? []);
    const missing = required.filter((s) => !granted.has(s));
    if (missing.length) {
      return challenge(403, ['error="insufficient_scope"', `scope="${quote(required.join(" "))}"`], "insufficient_scope", `Missing scope: ${missing.join(" ")}`);
    }
    setAuth(c, r);
    return next();
  };
}

export interface McpJwtVerifierOptions<U> {
  /** Verification key: public key (PEM / JWK / CryptoKey), JWKS document, or `createRemoteJwks()` resolver. */
  key: JwtKey | JwksResolver | JsonWebKeySet;
  algorithms: JwtAlgorithm[];
  /** Expected `iss`. Strongly recommended. */
  issuer?: string;
  leeway?: number;
  /** Map claims to your user. Default: the claims themselves. */
  toUser?: (claims: JwtPayload) => U | Promise<U>;
}

/**
 * A `verify` for `mcpAuth()` backed by JWT access tokens (RFC 9068): checks signature, expiry and issuer,
 * and reports `aud` and `scope` / `scp` for mcpAuth to enforce.
 */
export function mcpJwtVerifier<U = JwtPayload>(opts: McpJwtVerifierOptions<U>): (token: string) => Promise<McpAuthInfo<U>> {
  return async (token) => {
    const claims = await verifyJwt(token, opts.key, { algorithms: opts.algorithms, issuer: opts.issuer, leeway: opts.leeway });
    const raw = claims.scope ?? claims.scp;
    const scopes = typeof raw === "string" ? raw.split(" ").filter(Boolean) : Array.isArray(raw) ? raw.map(String) : [];
    const user = opts.toUser ? await opts.toUser(claims) : (claims as unknown as U);
    return { user, audience: claims.aud, scopes };
  };
}

function setAuth(c: Context<any, any>, info: McpAuthInfo<unknown>): void {
  c.set("user", info.user);
  c.set("auth", { scopes: info.scopes ?? [], audience: info.audience });
}

function normalizeAudience(a: string): string {
  if (!/^https?:\/\//i.test(a)) return a;
  try {
    const u = new URL(a);
    const p = u.pathname.replace(/\/+$/, "");
    return `${u.origin}${p}${u.search}`;
  } catch {
    return a;
  }
}

function quote(s: string): string {
  return s.replace(/["\\]/g, "");
}
