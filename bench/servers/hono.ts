// Hono: same routes; validation via the built-in hono/validator (no zod dependency).
import { Hono } from "hono";
import { validator } from "hono/validator";

const app = new Hono()
  .get("/", (c) => c.text("Hi"))
  .get("/user/:id", (c) => c.json({ id: c.req.param("id") }))
  .post(
    "/json",
    validator("json", (v, c) => {
      if (typeof v?.name !== "string" || !Number.isInteger(v?.age)) return c.json({ error: "invalid" }, 422);
      return { name: v.name as string, age: v.age as number };
    }),
    (c) => c.json(c.req.valid("json")),
  );

const server = Bun.serve({ port: Number(process.env.PORT ?? 0), fetch: app.fetch });
console.log(`LISTENING ${server.port}`);
