import { describe, expect, test } from "bun:test";
import { definePlugin, miu, route, t, validate } from "../src/index.ts";

describe("app.tools()", () => {
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/users/:id", { name: "getUser", summary: "Get a user", params: t.object({ id: t.integer() }), response: t.object({ id: t.number() }), handler: ({ params }) => ({ id: params.id }) }),
      route.post("/notes", { name: "createNote", auth: "required", body: t.object({ title: t.string() }), handler: ({ body }) => ({ title: body.title }) }),
      route.get("/hidden", { name: "hidden", mcp: false, handler: () => "x" }),
    ],
    plugins: [definePlugin({ name: "who", onRequest: (ctx) => { if (ctx.req.headers.get("authorization") === "Bearer ok") ctx.user = { id: "u1", roles: [] }; } })],
  });

  test("lists route tools without turning MCP on", async () => {
    await app.ready();
    const tools = app.tools();
    expect(tools.map((x) => x.name)).toEqual(["getUser", "createNote"]);
    expect(tools[0].inputSchema).toMatchObject({ type: "object", required: ["id"] });
    expect(tools[0].description).toContain("Get a user");
  });

  test("call() dispatches through the app and returns the parsed body", async () => {
    await app.ready();
    const getUser = app.tools().find((x) => x.name === "getUser")!;
    expect(await getUser.call({ id: 7 })).toMatchObject({ ok: true, status: 200, body: { id: 7 } });
  });

  test("call() forwards headers, so auth applies", async () => {
    await app.ready();
    const create = app.tools().find((x) => x.name === "createNote")!;
    expect((await create.call({ title: "a" })).status).toBe(401);
    expect(await create.call({ title: "a" }, { headers: { authorization: "Bearer ok" } })).toMatchObject({ ok: true, body: { title: "a" } });
  });
});

describe("Cloudflare AI and Vectorize bindings", () => {
  test("inspect() merges them", async () => {
    const app = miu({
      plugins: [
        definePlugin({ name: "ai", cloudflare: () => ({ ai: { binding: "AI" }, vectorize: [{ binding: "DOCS", indexName: "docs-index" }] }) }),
        definePlugin({ name: "ai2", cloudflare: () => ({ ai: { binding: "AI" } }) }),
      ],
    });
    await app.ready();
    const cf = app.inspect().cloudflare;
    expect(cf.ai).toEqual({ binding: "AI" });
    expect(cf.vectorize).toEqual([{ binding: "DOCS", indexName: "docs-index" }]);
  });
});

describe("schema wrappers and dates", () => {
  test("optional, nullable and default expose the inner schema", () => {
    const inner = t.string({ format: "email" });
    expect(t.optional(inner).inner).toBe(inner);
    expect(t.nullable(inner).inner).toBe(inner);
    expect(t.default(inner, "a@b.co").inner).toBe(inner);
  });

  test("t.date() accepts ISO strings and Dates and returns a Date", () => {
    const r = validate(t.date(), "2026-10-15T08:30:00Z", { coerce: true });
    expect(r.ok && r.value instanceof Date && r.value.toISOString()).toBe("2026-10-15T08:30:00.000Z");
    const d = new Date(0);
    expect(validate(t.date(), d)).toEqual({ ok: true, value: d });
    expect(validate(t.date(), "not a date").ok).toBe(false);
    expect(t.date().json).toEqual({ type: "string", format: "date-time" });
  });

  test("t.date() in a JSON body parses to a Date for the handler", async () => {
    const app = miu({ routes: [route.post("/e", { body: t.object({ at: t.date() }), handler: ({ body }) => ({ year: body.at.getUTCFullYear() }) })] });
    const res = await app.fetch(new Request("http://localhost/e", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: "2030-01-02T00:00:00Z" }) }));
    expect(await res.json()).toEqual({ year: 2030 });
  });
});
