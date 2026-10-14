/** Route-table inference on `Miu`. Type-checked by `bunx tsc --noEmit`; never executed. */
import { Miu, t } from "../../src/index.ts";
import type { RoutesOf } from "../../src/client/index.ts";
import { expectTypeOf, type Equal, type Expect } from "./expect.ts";

const Todo = t.object({ id: t.integer(), title: t.string(), done: t.optional(t.boolean()) });

const todos = new Miu()
  .get("/", () => [{ id: 1, title: "a" }])
  .get("/:id", { params: t.object({ id: t.integer() }), response: Todo }, (c) => ({ id: c.params.id, title: "x" }))
  .post("/", { body: t.object({ title: t.string() }) }, async (c) => ({ id: 1, title: c.body.title }));

const app = new Miu()
  .get("/health", () => "ok")
  .get("/users/:userId/posts/:postId", (c) => ({ user: c.params.userId }))
  .get("/search", { query: t.object({ q: t.string(), page: t.optional(t.integer()) }) }, (c) => c.query)
  .delete("/items/:id", () => undefined)
  .put("/raw", (c) => c.json({ a: 1 }))
  .all("/any", () => ({ any: true }))
  .ws("/socket", { message() {} })
  .route("/todos", todos);

type R = RoutesOf<typeof app>;

// keys: own paths, mounted paths (prefixed, "/" collapses onto the prefix), no ws routes
expectTypeOf<keyof R>().toEqualTypeOf<
  "/health" | "/users/:userId/posts/:postId" | "/search" | "/items/:id" | "/raw" | "/any" | "/todos" | "/todos/:id"
>();

// methods per path
expectTypeOf<keyof R["/todos"]>().toEqualTypeOf<"GET" | "POST">();
expectTypeOf<keyof R["/any"]>().toEqualTypeOf<"ALL">();

// output: handler return type, awaited
expectTypeOf<R["/health"]["GET"]["output"]>().toEqualTypeOf<string>();
expectTypeOf<R["/todos"]["GET"]["output"]>().toEqualTypeOf<{ id: number; title: string }[]>();
expectTypeOf<R["/todos"]["POST"]["output"]>().toEqualTypeOf<{ id: number; title: string }>();
// output: `response` schema wins over the handler's return type
expectTypeOf<R["/todos/:id"]["GET"]["output"]>().toEqualTypeOf<{ id: number; title: string; done?: boolean | undefined }>();
// output: no content -> void; raw Response -> unknown
expectTypeOf<R["/items/:id"]["DELETE"]["output"]>().toEqualTypeOf<void>();
expectTypeOf<R["/raw"]["PUT"]["output"]>().toEqualTypeOf<unknown>();

// params: from the schema, else from the path template
expectTypeOf<R["/todos/:id"]["GET"]["params"]>().toEqualTypeOf<{ id: number }>();
expectTypeOf<R["/users/:userId/posts/:postId"]["GET"]["params"]>().toEqualTypeOf<{ userId: string | number; postId: string | number }>();
expectTypeOf<R["/health"]["GET"]["params"]>().toEqualTypeOf<{}>();

// query / body from schemas
expectTypeOf<R["/search"]["GET"]["query"]>().toEqualTypeOf<{ q: string; page?: number | undefined }>();
expectTypeOf<R["/todos"]["POST"]["body"]>().toEqualTypeOf<{ title: string }>();

// handler input types are unchanged by the route-table inference
new Miu().post("/x", { body: t.object({ n: t.number() }), query: t.object({ s: t.string() }) }, (c) => {
  type _b = Expect<Equal<typeof c.body, { n: number }>>;
  type _q = Expect<Equal<typeof c.query, { s: string }>>;
  return null;
});

// a typed app is still usable where a plain `Miu` is expected
const plain: Miu = app;
const anyApp: Miu<any> = app;
void plain;
void anyApp;

// non-chained registration keeps working (routes are just not tracked on `app2`'s type)
const app2 = new Miu();
app2.get("/a", () => 1);
expectTypeOf<keyof RoutesOf<typeof app2>>().toEqualTypeOf<never>();
