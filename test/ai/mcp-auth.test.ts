import { describe, expect, test } from "bun:test";
import { Miu, t } from "../../src/index.ts";
import { mcp } from "../../src/ai/mcp.ts";
import { mcpAuth, mcpJwtVerifier, type McpAuthOptions } from "../../src/ai/mcp-auth.ts";
import { signJwt } from "../../src/batteries/auth/jwt.ts";

const RESOURCE = "https://api.example.com/mcp";
const META = "https://api.example.com/.well-known/oauth-protected-resource/mcp";

const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1" };

const token = (claims: Record<string, unknown>, opts: { expiresIn?: number } = {}) =>
  signJwt({ iss: "https://auth.example.com", ...claims }, keyPair.privateKey, { algorithm: "EdDSA", kid: "k1", expiresIn: opts.expiresIn ?? 300 });

const makeApp = (extra: Partial<McpAuthOptions<unknown>> = {}) =>
  new Miu({ name: "Todo", version: "0.1.0", logger: false })
    .use(
      mcpAuth({
        resource: RESOURCE,
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: ["todos:read", "todos:write"],
        verify: mcpJwtVerifier({
          key: { keys: [publicJwk] },
          algorithms: ["EdDSA"],
          issuer: "https://auth.example.com",
          toUser: (p) => ({ id: p.sub }),
        }),
        ...extra,
      }),
    )
    .use(mcp())
    .post("/todos", { body: t.object({ title: t.string() }), tool: { name: "create_todo" } }, (c) => ({
      title: c.body.title,
      user: c.get("user") ?? null,
    }))
    .get("/whoami", (c) => ({ user: c.get("user") ?? null }));

async function rpc(app: Miu<any>, method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await app.request("http://api.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : undefined };
}

describe("mcpAuth: protected resource metadata (RFC 9728)", () => {
  test("serves metadata at the path-suffixed and root well-known URLs", async () => {
    const app = makeApp({ resourceName: "Todo MCP", resourceDocumentation: "https://docs.example.com/mcp" });
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await app.request(`http://api.example.com${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["todos:read", "todos:write"],
        bearer_methods_supported: ["header"],
        resource_name: "Todo MCP",
        resource_documentation: "https://docs.example.com/mcp",
      });
    }
  });

  test("rejects invalid configuration", () => {
    const verify = async () => undefined;
    expect(() => mcpAuth({ resource: "/mcp", authorizationServers: ["https://a"], verify })).toThrow(/absolute/);
    expect(() => mcpAuth({ resource: "https://x/mcp#frag", authorizationServers: ["https://a"], verify })).toThrow(/fragment/);
    expect(() => mcpAuth({ resource: RESOURCE, authorizationServers: [], verify })).toThrow(/authorizationServers/);
  });
});

describe("mcpAuth: bearer enforcement on the MCP endpoint", () => {
  test("missing token → 401 with resource_metadata", async () => {
    const { res } = await rpc(makeApp(), "initialize", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${META}"`);
  });

  test("resource_metadata comes from the configured resource, never the Host header", async () => {
    const res = await makeApp().request("http://evil.example/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${META}"`);
  });

  test("invalid / expired / wrongly signed tokens → 401 invalid_token", async () => {
    const app = makeApp();
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const forged = await signJwt({ iss: "https://auth.example.com", aud: RESOURCE }, other.privateKey, { algorithm: "EdDSA", kid: "k1" });
    for (const bad of ["garbage", forged, await token({ aud: RESOURCE }, { expiresIn: -60 })]) {
      const { res } = await rpc(app, "initialize", {}, { authorization: `Bearer ${bad}` });
      expect(res.status).toBe(401);
      const h = res.headers.get("www-authenticate")!;
      expect(h).toContain('error="invalid_token"');
      expect(h).toContain(`resource_metadata="${META}"`);
    }
  });

  test("audience must be bound to this resource", async () => {
    const app = makeApp();
    for (const aud of ["https://other.example.com/mcp", undefined, ["https://api.example.com"]]) {
      const { res } = await rpc(app, "initialize", {}, { authorization: `Bearer ${await token({ sub: "u1", aud })}` });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    // extra accepted audiences can be configured
    const app2 = makeApp({ audiences: ["api://todo"] });
    const { res } = await rpc(app2, "ping", {}, { authorization: `Bearer ${await token({ sub: "u1", aud: "api://todo" })}` });
    expect(res.status).toBe(200);
  });

  test("required scopes → 403 insufficient_scope", async () => {
    const app = makeApp({ requiredScopes: ["todos:write"] });
    const weak = await token({ sub: "u1", aud: RESOURCE, scope: "todos:read" });
    const { res } = await rpc(app, "ping", {}, { authorization: `Bearer ${weak}` });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="todos:write", resource_metadata="${META}"`,
    );
    const strong = await token({ sub: "u1", aud: RESOURCE, scope: "todos:read todos:write" });
    expect((await rpc(app, "ping", {}, { authorization: `Bearer ${strong}` })).res.status).toBe(200);
  });

  test("valid token: MCP works and tool calls run as the token's user", async () => {
    const app = makeApp();
    const auth = { authorization: `Bearer ${await token({ sub: "u42", aud: [RESOURCE, "x"] })}` };
    const init = await rpc(app, "initialize", { protocolVersion: "2025-06-18" }, auth);
    expect(init.res.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("Todo");
    const call = await rpc(app, "tools/call", { name: "create_todo", arguments: { title: "milk" } }, auth);
    expect(call.body.result.isError).toBe(false);
    expect(call.body.result.structuredContent).toEqual({ title: "milk", user: { id: "u42" } });
  });

  test("other routes are not blocked, but a valid bearer sets the user", async () => {
    const app = makeApp();
    expect(await (await app.request("http://api.example.com/whoami")).json()).toEqual({ user: null });
    const good = await token({ sub: "u7", aud: RESOURCE });
    const res = await app.request("http://api.example.com/whoami", { headers: { authorization: `Bearer ${good}` } });
    expect(await res.json()).toEqual({ user: { id: "u7" } });
    const bad = await app.request("http://api.example.com/whoami", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ user: null });
    const off = makeApp({ authenticateRoutes: false });
    const r2 = await off.request("http://api.example.com/whoami", { headers: { authorization: `Bearer ${good}` } });
    expect(await r2.json()).toEqual({ user: null });
  });

  test("custom verify functions (e.g. token introspection) work too", async () => {
    const app = makeApp({
      verify: async (tok) => (tok === "opaque-ok" ? { user: { id: "intro" }, audience: RESOURCE, scopes: [] } : undefined),
    });
    expect((await rpc(app, "ping", {}, { authorization: "Bearer opaque-ok" })).res.status).toBe(200);
    expect((await rpc(app, "ping", {}, { authorization: "Bearer opaque-no" })).res.status).toBe(401);
  });

  test("tokens in the query string are not accepted", async () => {
    const good = await token({ sub: "u1", aud: RESOURCE });
    const res = await makeApp().request(`http://api.example.com/mcp?access_token=${good}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});
