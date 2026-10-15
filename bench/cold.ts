// Cold start for one framework, run in a fresh process by bench/run.ts:
//   bun bench/cold.ts <miujs|elysia|hono>
// Prints `<ms>`: time since process start until the first response body has been read
// (runtime boot + importing the framework + building a 3-route app + one in-process request).

const which = process.argv[2];
let f: (r: Request) => Response | Promise<Response>;
if (which === "miujs") {
  const { miu, route, t } = await import("miujs");
  const app = miu({
    dev: false,
    logLevel: "silent",
    routes: [
      route.get("/", { handler: () => "Hi" }),
      route.get("/users/:id", { params: t.object({ id: t.string() }), handler: ({ params }) => ({ id: params.id, name: "Mia" }) }),
      route.post("/json", { body: t.object({ name: t.string(), qty: t.integer({ min: 1 }) }), handler: ({ body }) => ({ ok: true, name: body.name, qty: body.qty }) }),
    ],
  });
  f = (r) => app.fetch(r);
} else if (which === "elysia") {
  const { Elysia, t } = await import("elysia");
  const app = new Elysia()
    .get("/", () => "Hi")
    .get("/users/:id", ({ params }) => ({ id: params.id, name: "Mia" }), { params: t.Object({ id: t.String() }) })
    .post("/json", ({ body }) => ({ ok: true, name: body.name, qty: body.qty }), { body: t.Object({ name: t.String(), qty: t.Integer({ minimum: 1 }) }) });
  f = (r) => app.handle(r);
} else {
  const { Hono } = await import("hono");
  const app = new Hono()
    .get("/", (c) => c.text("Hi"))
    .get("/users/:id", (c) => c.json({ id: c.req.param("id"), name: "Mia" }))
    .post("/json", async (c) => c.json(await c.req.json()));
  f = (r) => app.fetch(r);
}
await (await f(new Request("http://localhost/users/42"))).text();
console.log(performance.now().toFixed(2));

export {};
