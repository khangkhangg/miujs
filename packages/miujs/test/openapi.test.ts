import { describe, expect, test } from "bun:test";
import { miu, route, t } from "../src/index.ts";

const get = (app: ReturnType<typeof miu>, path: string) => app.fetch(new Request(`http://localhost${path}`));

const routes = [
  route.get("/users/:id", {
    name: "getUser",
    summary: "Get a user",
    description: "Looks a user up.",
    tags: ["users"],
    params: t.object({ id: t.integer() }),
    query: t.object({ expand: t.optional(t.boolean()), fields: t.array(t.string()) }),
    response: t.object({ id: t.integer() }),
    handler: ({ params }) => ({ id: params.id }),
  }),
  route.post("/users", {
    name: "createUser",
    body: t.object({ name: t.string() }),
    status: 201,
    auth: "required",
    handler: ({ body }) => body,
  }),
  route.put("/users/:id", { name: "putUser", body: t.optional(t.object({ name: t.string() })), auth: { role: "admin" }, handler: () => ({}) }),
  route.delete("/users/:id", { name: "deleteUser", auth: "optional", handler: () => {} }),
  route.get("/posts/:postId/comments/:commentId", { name: "getComment", handler: () => ({}) }),
  route.get("/files/*rest", { name: "file", handler: () => "" }),
  route.get("/raw/*", { name: "raw", handler: () => "" }),
  route.get("/hidden", { name: "hidden", mcp: false, handler: () => "" }),
];

describe("app.openapi()", () => {
  const app = miu({ name: "demo", version: "2.0.0", logLevel: "silent", routes });

  test("is an OpenAPI 3.1 document with app info", async () => {
    await app.ready();
    const doc = app.openapi() as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "demo", version: "2.0.0" });
  });

  test("converts :param and *wildcard to {param}", async () => {
    await app.ready();
    const paths = Object.keys((app.openapi() as any).paths);
    expect(paths).toEqual(["/users/{id}", "/users", "/posts/{postId}/comments/{commentId}", "/files/{rest}", "/raw/{wildcard}", "/hidden"]);
  });

  test("groups methods under one path and uses the route name as operationId", async () => {
    await app.ready();
    const p = (app.openapi() as any).paths["/users/{id}"];
    expect(Object.keys(p)).toEqual(["get", "put", "delete"]);
    expect(p.get.operationId).toBe("getUser");
    expect(p.put.operationId).toBe("putUser");
    expect(p.delete.operationId).toBe("deleteUser");
  });

  test("summary, description and tags", async () => {
    await app.ready();
    const op = (app.openapi() as any).paths["/users/{id}"].get;
    expect(op.summary).toBe("Get a user");
    expect(op.description).toBe("Looks a user up.");
    expect(op.tags).toEqual(["users"]);
    const bare = (app.openapi() as any).paths["/users"].post;
    expect(bare.summary).toBeUndefined();
    expect(bare.tags).toBeUndefined();
  });

  test("path and query parameters from schemas", async () => {
    await app.ready();
    expect((app.openapi() as any).paths["/users/{id}"].get.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer" } },
      { name: "expand", in: "query", required: false, schema: { type: "boolean" } },
      { name: "fields", in: "query", required: true, schema: { type: "array", items: { type: "string" } } },
    ]);
  });

  test("path params without a schema default to string; routes without inputs have no parameters", async () => {
    await app.ready();
    const doc = app.openapi() as any;
    expect(doc.paths["/posts/{postId}/comments/{commentId}"].get.parameters).toEqual([
      { name: "postId", in: "path", required: true, schema: { type: "string" } },
      { name: "commentId", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(doc.paths["/hidden"].get.parameters).toBeUndefined();
  });

  test("every path template variable has a matching path parameter", async () => {
    await app.ready();
    const doc = app.openapi() as any;
    for (const [path, ops] of Object.entries(doc.paths) as [string, any][]) {
      const vars = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const op of Object.values(ops) as any[]) {
        const names = (op.parameters ?? []).filter((p: any) => p.in === "path").map((p: any) => p.name);
        expect({ path, names }).toEqual({ path, names: vars });
      }
    }
  });

  test("requestBody from the body schema, optional bodies are not required", async () => {
    await app.ready();
    const doc = app.openapi() as any;
    expect(doc.paths["/users"].post.requestBody).toEqual({
      required: true,
      content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
    });
    expect(doc.paths["/users/{id}"].put.requestBody.required).toBe(false);
    expect(doc.paths["/users/{id}"].get.requestBody).toBeUndefined();
  });

  test("success response uses the configured status and response schema", async () => {
    await app.ready();
    const doc = app.openapi() as any;
    expect(doc.paths["/users/{id}"].get.responses["200"]).toEqual({
      description: "Success",
      content: { "application/json": { schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } },
    });
    expect(Object.keys(doc.paths["/users"].post.responses)).toEqual(["201", "default"]);
    expect(doc.paths["/users"].post.responses["201"]).toEqual({ description: "Success" });
  });

  test("every operation has a default error response that resolves", async () => {
    await app.ready();
    const doc = app.openapi() as any;
    for (const ops of Object.values(doc.paths) as any[]) {
      for (const op of Object.values(ops) as any[]) expect(op.responses.default).toEqual({ $ref: "#/components/responses/Error" });
    }
    const err = doc.components.responses.Error;
    expect(err.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Error" });
    expect(doc.components.schemas.Error.required).toEqual(["error"]);
    expect(doc.components.schemas.Error.properties.error.required).toEqual(["code", "message", "docs"]);
  });

  test("security only on routes that require a user", async () => {
    await app.ready();
    const doc = app.openapi() as any;
    expect(doc.paths["/users"].post.security).toEqual([{ bearer: [] }, { cookie: [] }]);
    expect(doc.paths["/users/{id}"].put.security).toEqual([{ bearer: [] }, { cookie: [] }]);
    expect(doc.paths["/users/{id}"].delete.security).toBeUndefined();
    expect(doc.paths["/users/{id}"].get.security).toBeUndefined();
    expect(Object.keys(doc.components.securitySchemes)).toEqual(["bearer", "cookie"]);
  });

  test("includes mcp: false routes but no internal routes", async () => {
    const a = miu({ logLevel: "silent", dev: true, mcp: true, routes });
    await a.ready();
    const paths = Object.keys((a.openapi() as any).paths);
    expect(paths).toContain("/hidden");
    expect(paths.some((p) => p.startsWith("/_miu") || p === "/mcp")).toBe(false);
  });

  test("info can be overridden", async () => {
    const a = miu({ name: "x", logLevel: "silent", openapi: { info: { title: "Pretty", description: "About" } }, routes: [] });
    await a.ready();
    expect((a.openapi() as any).info).toEqual({ title: "Pretty", version: "0.0.0", description: "About" });
  });
});

describe("/_miu/openapi.json", () => {
  const r = [route.get("/a", { name: "a", handler: () => "a" })];

  test("served in dev by default", async () => {
    const app = miu({ logLevel: "silent", dev: true, routes: r });
    const res = await get(app, "/_miu/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/a"].get.operationId).toBe("a");
  });

  test("not served in production by default", async () => {
    const app = miu({ logLevel: "silent", dev: false, routes: r });
    expect((await get(app, "/_miu/openapi.json")).status).toBe(404);
  });

  test("served in production with openapi: true", async () => {
    const app = miu({ logLevel: "silent", dev: false, openapi: true, routes: r });
    expect((await get(app, "/_miu/openapi.json")).status).toBe(200);
  });

  test("can be turned off in dev", async () => {
    const app = miu({ logLevel: "silent", dev: true, openapi: false, routes: r });
    expect((await get(app, "/_miu/openapi.json")).status).toBe(404);
  });

  test("custom path", async () => {
    const app = miu({ logLevel: "silent", dev: false, openapi: { path: "/openapi.json" }, routes: r });
    expect((await get(app, "/openapi.json")).status).toBe(200);
    expect((await get(app, "/_miu/openapi.json")).status).toBe(404);
  });

  test("matches app.openapi()", async () => {
    const app = miu({ logLevel: "silent", dev: true, routes: r });
    expect(await (await get(app, "/_miu/openapi.json")).json()).toEqual(app.openapi());
  });
});
