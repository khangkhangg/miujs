import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { miu, validate } from "miujs";
import { fromOpenApi, jsonSchemaToT, pydanticToT } from "../src/openapi.ts";

// Generated sources are written under this package (so "miujs" resolves) and imported for real.
const GEN = join(import.meta.dir, ".gen");
let n = 0;
async function load(files: { path: string; source: string }[], entry: string) {
  const dir = join(GEN, String(++n));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.source);
  }
  return import(join(dir, entry));
}
afterAll(() => rmSync(GEN, { recursive: true, force: true }));

describe("jsonSchemaToT", () => {
  test("scalars and constraints", () => {
    expect(jsonSchemaToT({ type: "string" })).toBe("t.string()");
    expect(jsonSchemaToT({ type: "string", minLength: 1, maxLength: 5, format: "email" })).toBe('t.string({ minLength: 1, maxLength: 5, format: "email" })');
    expect(jsonSchemaToT({ type: "string", format: "uri" })).toBe('t.string({ format: "url" })');
    expect(jsonSchemaToT({ type: "string", pattern: "^a/b$" })).toBe('t.string({ pattern: new RegExp("^a/b$") })');
    expect(jsonSchemaToT({ type: "integer", minimum: 0, exclusiveMaximum: 10 })).toBe("t.integer({ min: 0, max: 9 })");
    expect(jsonSchemaToT({ type: "number", maximum: 1.5 })).toBe("t.number({ max: 1.5 })");
    expect(jsonSchemaToT({ type: "boolean", description: "Is it?" })).toBe('t.boolean({ description: "Is it?" })');
    expect(jsonSchemaToT({ enum: ["a", "b"] })).toBe('t.enum(["a", "b"])');
    expect(jsonSchemaToT({ const: "x" })).toBe('t.literal("x")');
    expect(jsonSchemaToT({})).toBe("t.unknown()");
  });
  test("nullable forms (Pydantic Optional, OpenAPI 3.0 and 3.1)", () => {
    expect(jsonSchemaToT({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("t.nullable(t.string())");
    expect(jsonSchemaToT({ type: ["integer", "null"] })).toBe("t.nullable(t.integer())");
    expect(jsonSchemaToT({ type: "string", nullable: true })).toBe("t.nullable(t.string())");
    expect(jsonSchemaToT({ anyOf: [{ type: "string" }, { type: "integer" }] })).toBe("t.union([t.string(), t.integer()])");
  });
  test("objects, arrays, records and refs", () => {
    expect(jsonSchemaToT({ type: "array", items: { type: "string" }, minItems: 1 })).toBe("t.array(t.string(), { min: 1 })");
    expect(jsonSchemaToT({ type: "object", additionalProperties: { type: "integer" } })).toBe("t.record(t.integer())");
    expect(jsonSchemaToT({ $ref: "#/components/schemas/Item" })).toBe("Item");
    expect(jsonSchemaToT({ allOf: [{ $ref: "#/$defs/Item" }], description: "the item" })).toBe("Item");
    expect(jsonSchemaToT({ type: "object", properties: { id: { type: "integer" }, "x-y": { type: "string", default: "z" }, tags: { type: "array", items: { type: "string" } } }, required: ["id"] })).toBe(
      't.object({\n  id: t.integer(),\n  "x-y": t.default(t.string(), "z"),\n  tags: t.optional(t.array(t.string())),\n})',
    );
  });
});

const pydanticUser = {
  title: "User",
  type: "object",
  $defs: {
    Address: { title: "Address", type: "object", properties: { city: { type: "string" }, zip: { anyOf: [{ type: "string", pattern: "^\\d{5}$" }, { type: "null" }], default: null } }, required: ["city"] },
    Role: { title: "Role", enum: ["admin", "user"], type: "string" },
    Node: { title: "Node", type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/Node" } } } },
  },
  properties: {
    id: { type: "integer", minimum: 1 },
    email: { type: "string", format: "email" },
    role: { $ref: "#/$defs/Role", default: "user" },
    address: { anyOf: [{ $ref: "#/$defs/Address" }, { type: "null" }] },
    tree: { $ref: "#/$defs/Node" },
  },
  required: ["id", "email"],
};

describe("pydanticToT", () => {
  test("emits a module that compiles and validates like the Pydantic model", async () => {
    const source = pydanticToT(pydanticUser);
    expect(source).toContain('import { t, type Infer } from "miujs";');
    expect(source.indexOf("export const Address")).toBeLessThan(source.indexOf("export const User"));
    expect(source).toContain("export type User = Infer<typeof User>;");
    expect(source).toContain("recursive: Node");
    const mod = await load([{ path: "user.ts", source }], "user.ts");
    const ok = validate(mod.User, { id: 1, email: "a@b.co", address: { city: "Hanoi", zip: "12345" } });
    expect(ok).toEqual({ ok: true, value: { id: 1, email: "a@b.co", role: "user", address: { city: "Hanoi", zip: "12345" } } });
    expect(validate(mod.User, { id: 0, email: "nope" }).ok).toBe(false);
    expect(validate(mod.User, { id: 1, email: "a@b.co", role: "root" }).ok).toBe(false);
    expect(validate(mod.User, { id: 1, email: "a@b.co", address: { city: "x", zip: "1" } }).ok).toBe(false);
    expect(validate(mod.User, { id: 1, email: "a@b.co", address: null }).ok).toBe(true);
  });
  test("a name option and non-identifier titles", () => {
    expect(pydanticToT({ type: "string" }, { name: "Slug" })).toContain("export const Slug = t.string();");
    expect(pydanticToT({ title: "my-model 2", type: "boolean" })).toContain("export const my_model_2 = t.boolean();");
  });
});

// A FastAPI-style /openapi.json.
const spec = {
  openapi: "3.1.0",
  info: { title: "Shop", version: "1.0.0" },
  paths: {
    "/items/{item_id}": {
      get: {
        operationId: "read_item_items__item_id__get",
        summary: "Read Item",
        tags: ["items"],
        parameters: [
          { name: "item_id", in: "path", required: true, schema: { type: "integer" } },
          { name: "q", in: "query", required: false, schema: { anyOf: [{ type: "string" }, { type: "null" }] } },
          { name: "x-token", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } },
          "422": { description: "Validation Error", content: { "application/json": { schema: { $ref: "#/components/schemas/HTTPValidationError" } } } },
        },
      },
    },
    "/items": {
      post: {
        operationId: "create_item_items_post",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ItemCreate" } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } } },
        security: [{ OAuth2PasswordBearer: [] }],
      },
    },
    "/": { get: { responses: { "200": { description: "ok" } } } },
  },
  components: {
    schemas: {
      Item: { title: "Item", type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, price: { type: "number" } }, required: ["id", "name", "price"] },
      ItemCreate: { title: "ItemCreate", type: "object", properties: { name: { type: "string", minLength: 1 }, price: { type: "number", exclusiveMinimum: 0 } }, required: ["name", "price"] },
      HTTPValidationError: { title: "HTTPValidationError", type: "object", properties: { detail: { type: "array", items: {} } } },
    },
  },
};

describe("fromOpenApi", () => {
  test("produces route stubs grouped by resource, plus shared schemas", () => {
    const out = fromOpenApi(spec);
    expect(out.files.map((f) => f.path).sort()).toEqual(["routes/index.ts", "routes/items.ts", "routes/root.ts", "schemas.ts"]);
    expect(out.routes).toContainEqual({ method: "GET", path: "/items/:item_id", name: "read_item_items__item_id__get", file: "routes/items.ts" });
    const items = out.files.find((f) => f.path === "routes/items.ts")!.source;
    expect(items).toContain('route.get("/items/:item_id", {');
    expect(items).toContain("params: t.object({\n    item_id: t.integer(),\n  }),");
    expect(items).toContain("query: t.object({\n    q: t.optional(t.nullable(t.string())),\n  }),");
    expect(items).toContain("response: Item,");
    expect(items).toContain("status: 201,");
    expect(items).toContain('auth: "required"');
    expect(items).toContain("header x-token");
    const schemas = out.files.find((f) => f.path === "schemas.ts")!.source;
    expect(schemas).not.toContain("HTTPValidationError"); // only schemas the stubs use
  });

  test("the stubs run: validation works and handlers answer 501 until ported", async () => {
    const out = fromOpenApi(spec);
    const routes = await load(out.files, "routes/index.ts");
    const app = miu({ logLevel: "silent", routes: [routes] });
    const res = await app.request("/items/5?q=x");
    expect(res.status).toBe(501);
    const { error } = await res.json();
    expect(error.code).toBe("MIU_E_MIGRATE_NOT_PORTED");
    expect(error.fix).toContain("routes/items.ts");
    expect((await app.request("/items/abc")).status).toBe(400);
    const bad = await app.request("/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "", price: 0 }) });
    expect(bad.status).toBe(401); // auth: "required" (from the spec's security) is checked before the body
    await app.ready();
    expect(app.routes().map((r) => r.name).sort()).toEqual(["create_item_items_post", "get_root", "read_item_items__item_id__get"]);
  });

  test("Swagger 2 / non-specs are refused with a fix", () => {
    expect(() => fromOpenApi({ swagger: "2.0", paths: {} })).toThrow(expect.objectContaining({ code: "MIU_E_MIGRATE_OPENAPI" }));
    expect(() => fromOpenApi("nope" as unknown as object)).toThrow(expect.objectContaining({ code: "MIU_E_MIGRATE_OPENAPI" }));
  });

  test("unknown $refs are reported, not crashed on", () => {
    const out = fromOpenApi({ openapi: "3.0.0", paths: { "/x": { get: { responses: { "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } } } } } } });
    expect(out.warnings.join(" ")).toContain("Missing");
    expect(out.files.find((f) => f.path === "routes/x.ts")!.source).toContain("t.unknown()");
  });
});
