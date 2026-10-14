/** Typed `createClient<typeof app>()`. Type-checked by `bunx tsc --noEmit`; never executed. */
import { Miu, t } from "../../src/index.ts";
import { createClient, type Client } from "../../src/client/index.ts";
import { expectTypeOf } from "./expect.ts";

const Todo = t.object({ id: t.integer(), title: t.string() });

const app = new Miu()
  .get("/todos", { query: t.object({ done: t.optional(t.boolean()) }) }, () => [{ id: 1, title: "a" }])
  .get("/todos/:id", { params: t.object({ id: t.integer() }), response: Todo }, (c) => ({ id: c.params.id, title: "x" }))
  .post("/todos", { body: t.object({ title: t.string({ min: 1 }) }) }, (c) => ({ id: 1, title: c.body.title }))
  .patch("/todos/:id", { params: t.object({ id: t.integer() }), body: t.object({ title: t.optional(t.string()) }) }, () => ({ ok: true }))
  .delete("/todos/:id", () => undefined)
  .get("/search", { query: t.object({ q: t.string() }) }, (c) => ({ q: c.query.q }))
  .get("/files/*", (c) => c.params["*"])
  .all("/echo", () => ({ echoed: true }));

async function typed() {
  const client = createClient<typeof app>("http://localhost");

  // outputs
  expectTypeOf(await client.get("/todos")).toEqualTypeOf<{ id: number; title: string }[]>();
  expectTypeOf(await client.get("/todos/:id", { params: { id: 1 } })).toEqualTypeOf<{ id: number; title: string }>();
  expectTypeOf(await client.post("/todos", { body: { title: "x" } })).toEqualTypeOf<{ id: number; title: string }>();
  expectTypeOf(await client.delete("/todos/:id", { params: { id: 1 } })).toEqualTypeOf<void>();
  expectTypeOf(await client.request("PATCH", "/todos/:id", { params: { id: 1 }, body: {} })).toEqualTypeOf<{ ok: boolean }>();
  expectTypeOf(await client.get("/files/*", { params: { path: "a/b.txt" } })).toEqualTypeOf<string>();
  // ALL routes answer any method
  expectTypeOf(await client.put("/echo")).toEqualTypeOf<{ echoed: boolean }>();
  expectTypeOf(await client.request("OPTIONS", "/echo")).toEqualTypeOf<{ echoed: boolean }>();

  // optional query/body, extra request options
  await client.get("/todos", { query: { done: true }, headers: { "x-a": "1" }, signal: AbortSignal.timeout(1) });
  await client.patch("/todos/:id", { params: { id: 1 } });
  await client.post("/todos", { body: new FormData() });

  // @ts-expect-error unknown path
  await client.get("/nope");
  // @ts-expect-error method not registered for this path
  await client.put("/todos");
  // @ts-expect-error unknown method for request()
  await client.request("PUT", "/search", { query: { q: "x" } });
  // @ts-expect-error params required when the path has params
  await client.get("/todos/:id");
  // @ts-expect-error params must match the schema
  await client.get("/todos/:id", { params: { id: "1" } });
  // @ts-expect-error missing param key
  await client.get("/todos/:id", { params: {} });
  // @ts-expect-error params not accepted on a path without params
  await client.get("/todos", { params: { id: 1 } });
  // @ts-expect-error required query
  await client.get("/search");
  // @ts-expect-error query must match the schema
  await client.get("/search", { query: { q: 1 } });
  // @ts-expect-error required body
  await client.post("/todos");
  // @ts-expect-error body must match the schema
  await client.post("/todos", { body: { title: 1 } });
  // @ts-expect-error wildcard needs `path`
  await client.get("/files/*");
}

async function untyped() {
  // No app type: the previous loose API (any path, explicit result type)
  const client = createClient("http://localhost");
  expectTypeOf(client).toEqualTypeOf<Client>();
  expectTypeOf(await client.get<{ a: 1 }>("/whatever", { params: { x: 1 }, query: { a: "b" } })).toEqualTypeOf<{ a: 1 }>();
  const loose = await client.request("GET", "/x");
  expectTypeOf(loose).toEqualTypeOf<any>();
}

void typed;
void untyped;
