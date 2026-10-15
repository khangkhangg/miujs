// Memory and exit health of the core request path. Each check runs thousands of requests and
// fails if live memory keeps growing after warm-up.
import { describe, expect, test } from "bun:test";
import { definePlugin, errors, miu, route, t } from "../../packages/miujs/src/index.ts";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../lib/leak.ts";

const CORE = join(import.meta.dir, "..", "..", "packages", "miujs");

const app = miu({
  logLevel: "silent",
  dev: false,
  mcp: true,
  routes: [
    route.get("/", { handler: () => "Hi" }),
    route.get("/users/:id", { params: t.object({ id: t.integer() }), handler: ({ params }) => ({ id: params.id }) }),
    route.post("/json", { body: t.object({ name: t.string(), qty: t.integer() }), handler: ({ body }) => body }),
    route.get("/cookie", { handler: (ctx) => { ctx.cookies.set("a", "1"); return "ok"; } }),
    route.get("/err", { handler: () => { throw errors.notFound("thing"); } }),
    route.get("/later", { handler: (ctx) => { ctx.waitUntil(Promise.resolve()); return "ok"; } }),
  ],
  plugins: [definePlugin({ name: "hooks", onRequest: (ctx) => { ctx.state.x = 1; }, onResponse: () => {} })],
});
await app.ready();

const get = (path: string) => async () => void (await (await app.fetch(new Request(`http://localhost${path}`))).arrayBuffer());
const post = (path: string, body: unknown) => async () =>
  void (await (await app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))).arrayBuffer());

describe("core request path does not leak", () => {
  const cases: [string, () => Promise<void>][] = [
    ["text route", get("/")],
    ["params + validation", get("/users/42")],
    ["validation error", get("/users/abc")],
    ["JSON body", post("/json", { name: "tea", qty: 2 })],
    ["cookies", get("/cookie")],
    ["thrown MiuError", get("/err")],
    ["404 with suggestions", get("/nope/nothing")],
    ["waitUntil", get("/later")],
    ["MCP tools/list", post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })],
  ];
  for (const [name, fn] of cases) {
    test(name, async () => {
      const r = await leakCheck(name, fn, { perRound: 3000, rounds: 5 });
      expect(r.leaking, describeLeak(r)).toBe(false);
    }, 60_000);
  }
});

test("an app that never listens lets the process exit", async () => {
  const r = await exitCheck(`
    import { miu, route } from "../src/index.ts";
    const app = miu({ logLevel: "silent", routes: [route.get("/", { handler: () => "ok" })] });
    await app.ready();
    await app.fetch(new Request("http://localhost/"));
  `, 3000, CORE);
  expect(r.exited, r.stderr).toBe(true);
});

test("listen() then stop() lets the process exit", async () => {
  const r = await exitCheck(`
    import { miu, route } from "../src/index.ts";
    const app = miu({ logLevel: "silent", routes: [route.get("/", { handler: () => "ok" })] });
    const s = await app.listen(0, "127.0.0.1");
    await fetch(s.url);
    await s.stop();
  `, 3000, CORE);
  expect(r.exited, r.stderr).toBe(true);
});
