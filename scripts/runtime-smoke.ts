// Runs the same checks over real HTTP on whichever runtime executes it:
//   bun scripts/runtime-smoke.ts
//   node scripts/runtime-smoke.ts
//   deno run -A scripts/runtime-smoke.ts
// Exits non-zero on the first failure.
import { detectRuntime, errors, miu, route, t } from "../packages/miujs/src/index.ts";

let background = false;
const app = miu({
  name: "smoke",
  logLevel: "silent",
  dev: false,
  mcp: true,
  maxBodySize: 256,
  routes: [
    route.get("/hello", { summary: "Say hello", handler: () => ({ hi: "there" }) }),
    route.get("/users/:id", { params: t.object({ id: t.integer() }), handler: ({ params }) => ({ id: params.id }) }),
    route.post("/echo", { body: t.object({ text: t.string() }), handler: ({ body }) => ({ text: body.text }) }),
    route.get("/missing", { handler: () => { throw errors.notFound("thing", "7"); } }),
    route.get("/cookie", { handler: (ctx) => { ctx.cookies.set("a", "1"); ctx.cookies.set("b", "2"); return "ok"; } }),
    route.get("/ip", { handler: (ctx) => ({ ip: ctx.ip ?? null }) }),
    route.get("/later", { handler: (ctx) => { ctx.waitUntil(new Promise<void>((r) => setTimeout(() => { background = true; r(); }, 10))); return "ok"; } }),
  ],
});

const checks: [string, () => Promise<void>][] = [];
const check = (name: string, fn: () => Promise<void>) => checks.push([name, fn]);
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const server = await app.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${server.port}`;

check("JSON route", async () => {
  const r = await fetch(`${base}/hello`);
  assert(r.status === 200 && (await r.json()).hi === "there", "GET /hello");
});
check("params coercion and validation", async () => {
  assert((await (await fetch(`${base}/users/42`)).json()).id === 42, "coerced id");
  const bad = await fetch(`${base}/users/abc`);
  assert(bad.status === 400 && (await bad.json()).error.code === "MIU_E_VALIDATION", "400 on bad id");
});
check("JSON body", async () => {
  const r = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "xin chào" }) });
  assert((await r.json()).text === "xin chào", "echo");
});
check("body size limit", async () => {
  const r = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(1000) }) });
  assert(r.status === 413, `413 expected, got ${r.status}`);
});
check("MiuError response", async () => {
  const r = await fetch(`${base}/missing`);
  assert(r.status === 404 && (await r.json()).error.code === "MIU_E_NOT_FOUND", "404");
});
check("multiple Set-Cookie", async () => {
  const r = await fetch(`${base}/cookie`);
  assert(r.headers.getSetCookie().length === 2, "two cookies");
});
check("ctx.ip", async () => {
  const { ip } = await (await fetch(`${base}/ip`)).json();
  assert(typeof ip === "string" && ip.endsWith("127.0.0.1"), `ip was ${ip}`);
});
check("MCP initialize and tools/list", async () => {
  const call = (method: string) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }) }).then((r) => r.json());
  assert((await call("initialize")).result.serverInfo.name === "smoke", "initialize");
  assert((await call("tools/list")).result.tools.some((x: { name: string }) => x.name === "get_hello"), "tools/list");
});
check("waitUntil + drain", async () => {
  await fetch(`${base}/later`);
  await app.drain();
  assert(background, "background work finished");
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}
await server.stop();
console.log(`${detectRuntime()}: ${checks.length - failed}/${checks.length} passed`);
if (failed) throw new Error(`${failed} runtime checks failed`);
