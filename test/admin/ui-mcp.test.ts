import { describe, expect, test } from "bun:test";
import { client, makeApp } from "./helpers.ts";

const rpc = (app: ReturnType<typeof makeApp>["app"], method: string, params: unknown, headers: Record<string, string> = {}) =>
  app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json() as Promise<any>);

describe("admin UI page", () => {
  test("served at the mount root with a strict nonce CSP, DENY framing and no-store", async () => {
    const { app } = makeApp({ title: "Tour <Admin>" });
    const a = await client(app, "admin");
    const res = await a.call("GET", "/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /'nonce-([A-Za-z0-9+/_=-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) expect(csp).toContain(d);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    const html = await res.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s[1]).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
    expect(html).not.toMatch(/\sstyle\s*=/i); // no inline style attributes
    expect(html).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/); // no CDN
    expect(html).toContain("Tour &lt;Admin&gt;");

    const again = await a.call("GET", "/admin");
    expect(again.headers.get("content-security-policy")).not.toBe(csp); // fresh nonce per response
  });

  test("anonymous users get 401 for the page (no redirect configured)", async () => {
    const { app } = makeApp();
    expect((await app.request("/admin")).status).toBe(401);
  });
});

describe("admin over MCP", () => {
  test("tools/list exposes admin tools named after resources", async () => {
    const { app } = makeApp();
    const out = await rpc(app, "tools/list", {});
    const names = out.result.tools.map((t: any) => t.name);
    for (const n of ["admin_list_tours", "admin_get_tours", "admin_create_tours", "admin_update_tours", "admin_delete_tours", "admin_list_categories", "admin_meta"]) {
      expect(names).toContain(n);
    }
    expect(names.some((n: string) => n.includes("csrf") || n.includes("files"))).toBe(false);
    const create = out.result.tools.find((t: any) => t.name === "admin_create_tours");
    expect(create.inputSchema.properties.title.type).toBe("string");
    expect(create.inputSchema.required).toContain("title");
    expect(create.inputSchema.properties.views).toBeUndefined();
    const del = out.result.tools.find((t: any) => t.name === "admin_delete_tours");
    expect(del.annotations.destructiveHint).toBe(true);
  });

  test("tools/call respects authentication and roles", async () => {
    const { app } = makeApp();
    const ok = await rpc(app, "tools/call", { name: "admin_create_tours", arguments: { title: "Via MCP" } }, { authorization: "Bearer tok-admin" });
    expect(ok.result.isError).toBe(false);
    expect(ok.result.structuredContent.title).toBe("Via MCP");
    const id = ok.result.structuredContent.id;

    const upd = await rpc(app, "tools/call", { name: "admin_update_tours", arguments: { id, status: "published" } }, { authorization: "Bearer tok-admin" });
    expect(upd.result.structuredContent.status).toBe("published");

    const list = await rpc(app, "tools/call", { name: "admin_list_tours", arguments: { q: "mcp", filter: { status: "published" } } }, { authorization: "Bearer tok-admin" });
    expect(list.result.structuredContent.total).toBe(1);

    const editor = await rpc(app, "tools/call", { name: "admin_delete_tours", arguments: { id } }, { authorization: "Bearer tok-editor" });
    expect(editor.result.isError).toBe(true);
    expect(editor.result.content[0].text).toContain("403");

    const anon = await rpc(app, "tools/call", { name: "admin_list_tours", arguments: {} });
    expect(anon.result.isError).toBe(true);
  });

  test("cookie-forwarded MCP writes are blocked by CSRF (no token), reads work", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const write = await rpc(app, "tools/call", { name: "admin_create_tours", arguments: { title: "x" } }, { cookie: a.cookie });
    expect(write.result.isError).toBe(true);
    const read = await rpc(app, "tools/call", { name: "admin_list_tours", arguments: {} }, { cookie: a.cookie });
    expect(read.result.isError).toBe(false);
  });
});
