// MIU_ENV=development bun --inspect examples/devtools.ts
//
// Then:
//   - open the inspector URL printed in the console (http://localhost:3000/__miu?token=…)
//   - open http://localhost:3000/tours/1 in Chrome → DevTools → Network → Timing shows Server-Timing
//   - open http://localhost:3000/tours/999/boom → the dev error page (curl it for problem+json with a stack)
//   - open the debug.bun.sh link printed by --inspect to set breakpoints in this TypeScript file
//
// Without MIU_ENV=development (or NODE_ENV=development) every dev feature below is off: unknown
// environments are treated like production on purpose.
import { HttpError, Miu, llms, mcp, openapi, t } from "../src/index.ts";
import { devErrors, devLogger, getTiming, inspector, isDev, timing } from "../src/devtools/index.ts";

const tours = new Map([
  [1, { id: 1, title: "Old Town at dusk", scenes: 12 }],
  [2, { id: 2, title: "Harbour walk", scenes: 7 }],
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = new Miu({ name: "tours-devtools-demo", version: "0.1.0" })
  // Order matters: the inspector first (records everything), then timing (so `total` covers the rest).
  .use(inspector()) // /__miu — dev only, loopback only, token-protected
  .use(timing()) // Server-Timing — on in dev, off in production unless { enabled: true }
  .use(devLogger()) // colored lines in dev, JSON lines in production
  .use(openapi())
  .use(llms())
  .use(mcp())
  .onError(devErrors({ editor: "vscode" })) // HTML page / problem+json with stack in dev; plain problem+json in prod
  .get("/tours", { summary: "List tours" }, async (c) => {
    const t = getTiming(c);
    const rows = await t.measure("db", async () => {
      await sleep(8);
      return [...tours.values()];
    }, "SELECT tours");
    t.add("cache", undefined, "miss");
    return { items: rows };
  })
  .get("/tours/:id", { summary: "Get a tour", params: t.object({ id: t.integer() }) }, async (c) => {
    const timer = getTiming(c);
    timer.start("db", "SELECT tour");
    await sleep(5);
    const tour = tours.get(c.params.id);
    timer.end("db");
    if (!tour) throw new HttpError(404, "Tour not found", { code: "tour_not_found" });
    return tour;
  })
  .get("/tours/:id/boom", { summary: "Always fails (demo)", tool: false }, () => {
    try {
      JSON.parse("{not json");
    } catch (cause) {
      throw new Error("Could not load scene graph", { cause });
    }
  });

if (!isDev()) console.warn("[demo] Not a development environment: run with MIU_ENV=development to enable devtools.");

const server = app.listen(3000);
console.log(`Listening on http://localhost:${server.port}`);
