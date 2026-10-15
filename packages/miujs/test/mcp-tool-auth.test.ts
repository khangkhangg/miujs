// Plugin MCP tools declare `auth` / `permission` like routes, and the MCP endpoint enforces them.
import { describe, expect, test } from "bun:test";
import { definePlugin, errors, miu, type McpTool } from "../src/index.ts";

type User = { id: string; roles: string[]; perms?: string[] };

/** Reads the caller from `x-user` (JSON), like an auth plugin would from a session or token. */
const fakeAuth = (opts: { authorize?: boolean } = {}) =>
  definePlugin({
    name: "fake-auth",
    onRequest(ctx) {
      const raw = ctx.headers.get("x-user");
      const user: User | undefined = raw ? JSON.parse(raw) : undefined;
      (ctx as any).user = user;
      if (opts.authorize) {
        (ctx as any).authorize = (p: string) => {
          if (!user) throw errors.unauthorized();
          if (!user.perms?.includes(p)) throw errors.forbidden(`Requires permission: ${p}`);
        };
      }
    },
  });

function setup(tools: McpTool[], opts: { authorize?: boolean } = {}) {
  const calls: string[] = [];
  const wrapped = tools.map((t) => ({ ...t, call: (a: Record<string, unknown>, c: any) => (calls.push(t.name), t.call(a, c)) }));
  const app = miu({ logLevel: "silent", mcp: true, plugins: [fakeAuth(opts), definePlugin({ name: "tools", mcpTools: () => wrapped })] });
  const rpc = async (method: string, params: unknown, user?: User) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) headers["x-user"] = JSON.stringify(user);
    const res = await app.request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await res.json()) as any;
  };
  const call = async (name: string, user?: User) => (await rpc("tools/call", { name, arguments: {} }, user)).result;
  const list = async (user?: User) => ((await rpc("tools/list", {}, user)).result.tools as { name: string }[]).map((t) => t.name);
  return { app, calls, call, list };
}

const tool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({ name, inputSchema: { type: "object", properties: {} }, call: () => ({ ok: name }), ...extra });
const ann: User = { id: "ann", roles: [] };
const admin: User = { id: "op", roles: ["admin"] };
const code = (r: any) => JSON.parse(r.content[0].text).error.code;

describe("plugin MCP tools with auth / permission", () => {
  test('auth: "required" refuses anonymous callers (401) without running the tool', async () => {
    const { call, calls } = setup([tool("secret", { auth: "required" })]);
    const anon = await call("secret");
    expect(anon.isError).toBe(true);
    expect(code(anon)).toBe("MIU_E_UNAUTHORIZED");
    expect(calls).toEqual([]);
    const ok = await call("secret", ann);
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toEqual({ ok: "secret" });
  });

  test("auth: { role } refuses users without the role (403)", async () => {
    const { call, calls } = setup([tool("ops", { auth: { role: ["admin", "owner"] } })]);
    expect(code(await call("ops"))).toBe("MIU_E_UNAUTHORIZED");
    expect(code(await call("ops", ann))).toBe("MIU_E_FORBIDDEN");
    expect(calls).toEqual([]);
    expect((await call("ops", admin)).isError).toBe(false);
  });

  test("permission is checked with ctx.authorize; without an access plugin the tool fails closed", async () => {
    const unchecked = setup([tool("rooms", { permission: "rooms:read" })]);
    const r = await unchecked.call("rooms", admin);
    expect(r.isError).toBe(true);
    expect(code(r)).toBe("MIU_E_PERMISSION_UNCHECKED");
    expect(unchecked.calls).toEqual([]);

    const { call, calls } = setup([tool("rooms", { permission: "rooms:read" })], { authorize: true });
    expect(code(await call("rooms"))).toBe("MIU_E_UNAUTHORIZED");
    expect(code(await call("rooms", ann))).toBe("MIU_E_FORBIDDEN");
    expect(calls).toEqual([]);
    expect((await call("rooms", { ...ann, perms: ["rooms:read"] })).isError).toBe(false);
  });

  test("tools/list shows each caller only the tools they may call", async () => {
    const { list } = setup(
      [tool("open"), tool("optional", { auth: "optional" }), tool("signedIn", { auth: "required" }), tool("ops", { auth: { role: "admin" } }), tool("perm", { permission: "rooms:read" })],
      { authorize: true },
    );
    expect(await list()).toEqual(["open", "optional"]);
    expect(await list(ann)).toEqual(["open", "optional", "signedIn"]);
    expect(await list(admin)).toEqual(["open", "optional", "signedIn", "ops"]);
    expect(await list({ ...ann, perms: ["rooms:read"] })).toEqual(["open", "optional", "signedIn", "perm"]);
  });

  test("an invalid auth value on a plugin tool fails at startup, never public", async () => {
    for (const auth of [true, "admin", { roles: ["admin"] }]) {
      const { app } = setup([tool("t", { auth: auth as any })]);
      await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_AUTH_INVALID" });
    }
  });
});
