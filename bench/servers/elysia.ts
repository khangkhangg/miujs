// Elysia: same routes; validation with its built-in TypeBox `t`.
import { Elysia, t } from "elysia";

const app = new Elysia()
  .get("/", () => "Hi")
  .get("/user/:id", ({ params }) => ({ id: params.id }))
  .post("/json", ({ body }) => body, { body: t.Object({ name: t.String(), age: t.Integer() }) })
  .listen(Number(process.env.PORT ?? 0));

console.log(`LISTENING ${app.server?.port}`);
