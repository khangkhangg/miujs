import { expect, test } from "bun:test";
import { miu, route, t, validate } from "../src/index.ts";

test("t.object rest keeps and validates extra keys", () => {
  const s = t.object({ q: t.optional(t.string()) }, { rest: t.string() });
  expect(validate(s, { q: "a", "stage[in]": "lead,won" })).toEqual({ ok: true, value: { q: "a", "stage[in]": "lead,won" } });
  expect(validate(s, { other: 5 }).ok).toBe(false);
  expect(s.json.additionalProperties).toEqual({ type: "string" });
});

test("query rest keys reach the handler", async () => {
  const app = miu({
    routes: [route.get("/list", { query: t.object({ q: t.optional(t.string()) }, { rest: t.string() }), handler: ({ query }) => query })],
  });
  const res = await app.fetch(new Request("http://localhost/list?q=x&stage%5Bin%5D=lead"));
  expect(await res.json()).toEqual({ q: "x", "stage[in]": "lead" });
});

test("route annotations override MCP tool hints", async () => {
  const app = miu({
    mcp: true,
    routes: [route.post("/things/bulk", { name: "things_bulk", annotations: { destructiveHint: true }, handler: () => ({}) })],
  });
  await app.ready();
  expect(app.tools()[0].annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
});

test("responseType sets the OpenAPI response content type", async () => {
  const app = miu({ routes: [route.get("/export.csv", { name: "export", responseType: "text/csv", handler: () => "a,b\n" })] });
  await app.ready();
  const op = (app.openapi() as any).paths["/export.csv"].get;
  expect(Object.keys(op.responses["200"].content)).toEqual(["text/csv"]);
});
