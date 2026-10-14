// Miu: GET / text, GET /user/:id JSON, POST /json validated echo.
import { Miu, t } from "../../src/index.ts";

const app = new Miu({ logger: false })
  .get("/", () => "Hi")
  .get("/user/:id", (c) => ({ id: c.params.id }))
  .post("/json", { body: t.object({ name: t.string(), age: t.integer() }) }, (c) => c.body);

// serveOptions() lets Bun's native router dispatch routes (what app.listen() uses).
const server = Bun.serve(app.serveOptions({ port: Number(process.env.PORT ?? 0) }));
console.log(`LISTENING ${server.port}`);
