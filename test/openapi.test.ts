import { describe, expect, test } from "bun:test";
import { Miu, t } from "../src/index.ts";
import { openapi, generateOpenAPI } from "../src/ai/openapi.ts";

const makeApp = () =>
  new Miu({ name: "Shop", version: "1.2.3" })
    .get(
      "/products/:id",
      {
        summary: "Get a product",
        tags: ["products"],
        params: t.object({ id: t.integer({ description: "Product id" }) }),
        query: t.object({ currency: t.optional(t.enum(["USD", "EUR"])) }),
        response: t.object({ id: t.integer(), name: t.string() }),
      },
      (c) => ({ id: c.params.id, name: "Mug" }),
    )
    .post("/products", { body: t.object({ name: t.string() }) }, (c) => c.body)
    .get("/files/*", () => "f")
    .get("/internal", { hidden: true }, () => "x");

describe("OpenAPI", () => {
  test("documents info, paths and converts :params to {params}", () => {
    const doc = generateOpenAPI(makeApp());
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Shop", version: "1.2.3" });
    expect(Object.keys(doc.paths)).toEqual(["/products/{id}", "/products", "/files/{path}"]);
  });

  test("documents parameters, request body and responses", () => {
    const op = generateOpenAPI(makeApp()).paths["/products/{id}"]!.get as any;
    expect(op.summary).toBe("Get a product");
    expect(op.tags).toEqual(["products"]);
    expect(op.operationId).toBe("get_products_by_id");
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer", description: "Product id" } },
      { name: "currency", in: "query", required: false, schema: { type: "string", enum: ["USD", "EUR"] } },
    ]);
    expect(op.responses["200"].content["application/json"].schema.properties.name).toEqual({ type: "string" });
    expect(op.responses["422"]).toBeDefined();

    const post = generateOpenAPI(makeApp()).paths["/products"]!.post as any;
    expect(post.requestBody.content["application/json"].schema.required).toEqual(["name"]);
  });

  test("openapi() plugin serves the document", async () => {
    const app = makeApp().use(openapi({ path: "/openapi.json" }));
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).paths["/products"]).toBeDefined();
  });
});
