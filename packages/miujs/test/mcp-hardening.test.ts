import { expect, test } from "bun:test";
import { definePlugin, miu, route, t } from "../src/index.ts";

const rpc = (app: ReturnType<typeof miu>, method: string, params?: unknown) =>
  app.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));

test("two routes whose tool names collide fail at startup", async () => {
  const app = miu({
    mcp: true,
    routes: [route.get("/a", { name: "a.b", handler: () => ({}) }), route.get("/b", { name: "a_b", handler: () => ({}) })],
  });
  await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_MCP_TOOL_DUPLICATE" });
});

test("a plugin tool with a route tool's name fails at startup", async () => {
  const app = miu({
    mcp: true,
    routes: [route.get("/x", { name: "ping", handler: () => ({}) })],
    plugins: [definePlugin({ name: "p", mcpTools: () => [{ name: "ping", inputSchema: { type: "object" }, call: () => ({}) }] })],
  });
  await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_MCP_TOOL_DUPLICATE" });
});

test("structuredContent is only sent when the body matches the output schema (even in production)", async () => {
  const app = miu({
    dev: false,
    mcp: true,
    routes: [route.get("/bad", { name: "bad", response: t.object({ id: t.string() }), handler: () => ({ id: 42 }) as any })],
  });
  const res = await (await rpc(app, "tools/call", { name: "bad", arguments: {} })).json();
  expect(res.result.structuredContent).toBeUndefined();
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("MIU_E_RESPONSE_INVALID");
});

test("a query key that shadows a path param fails at startup", async () => {
  const app = miu({
    routes: [route.get("/users/:id", { params: t.object({ id: t.string() }), query: t.object({ id: t.optional(t.string()) }), handler: () => ({}) })],
  });
  await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_PARAM_SHADOWED" });
});
