// npx wrangler dev examples/cloudflare/worker.ts
import { Miu, t, mcp, openapi } from "../../src/index.ts";

type Bindings = { GREETING?: string; KV?: { get(key: string): Promise<string | null> } };

const app = new Miu<{ Bindings: Bindings }>({ name: "miu-worker", version: "0.1.0" })
  .use(openapi())
  .use(mcp())
  .get("/hello/:name", { params: t.object({ name: t.string() }) }, (c) => ({
    message: `${c.env.GREETING ?? "Hello"}, ${c.params.name}!`,
  }));

// A Miu app *is* a Workers module: `fetch(request, env, ctx)`.
export default app;
