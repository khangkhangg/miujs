// Miu: GET / text, GET /user/:id JSON, POST /json validated echo.
import { Miu, t } from "../../src/index.ts";

const app = new Miu({ logger: false })
  .get("/", () => "Hi")
  .get("/user/:id", (c) => ({ id: c.params.id }))
  .post("/json", { body: t.object({ name: t.string(), age: t.integer() }) }, (c) => c.body);

const server = Bun.serve({ port: Number(process.env.PORT ?? 0), fetch: app.fetch });
console.log(`LISTENING ${server.port}`);
