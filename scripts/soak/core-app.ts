// The bare core app used by the soak: miujs only, no plugins. Imported by relative path so the
// same file runs on Bun, Node and Deno (like scripts/runtime-smoke.ts).
import { miu, route, t } from "../../packages/miujs/src/index.ts";

export function createCoreApp(extraRoutes: unknown[] = []) {
  return miu({
    name: "soak-core",
    logLevel: "silent",
    dev: false,
    routes: [
      route.get("/", { handler: () => "ok" }),
      route.get("/json", { handler: () => ({ hello: "world", items: [1, 2, 3], ok: true }) }),
      route.get("/users/:id", { params: t.object({ id: t.integer() }), handler: ({ params }) => ({ id: params.id, name: "Mia" }) }),
      route.post("/echo", {
        body: t.object({ name: t.string({ maxLength: 100 }), qty: t.integer({ min: 1 }) }),
        handler: ({ body }) => ({ ok: true, name: body.name, qty: body.qty }),
      }),
      ...(extraRoutes as never[]),
    ],
  });
}
