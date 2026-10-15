// Core only (no batteries): routing, validation, errors, cookies, ctx.ip, waitUntil, MCP and a
// WebSocket through ctx.upgrade (WebSocketPair on Workers). Mirrors scripts/runtime-smoke.ts.
import { errors, miu, route, t } from "miujs";

let background = 0;

export default miu({
  name: "core",
  logLevel: "warn",
  dev: false,
  mcp: true,
  maxBodySize: 256,
  routes: [
    route.get("/hello", { summary: "Say hello", handler: (ctx) => ({ hi: "there", runtime: ctx.runtime }) }),
    route.get("/users/:id", { params: t.object({ id: t.integer() }), handler: ({ params }) => ({ id: params.id }) }),
    route.post("/echo", { body: t.object({ text: t.string() }), handler: ({ body }) => ({ text: body.text }) }),
    route.get("/missing", {
      handler: () => {
        throw errors.notFound("thing", "7");
      },
    }),
    route.get("/cookie", {
      handler: (ctx) => {
        ctx.cookies.set("a", "1");
        ctx.cookies.set("b", "2");
        return "ok";
      },
    }),
    route.get("/ip", { handler: (ctx) => ({ ip: ctx.ip ?? null }) }),
    route.get("/later", {
      handler: (ctx) => {
        ctx.waitUntil(new Promise<void>((r) => setTimeout(() => (background++, r()), 10)));
        return "ok";
      },
    }),
    route.get("/background", { handler: () => ({ background }) }),
    route.get("/ws", {
      mcp: false,
      handler: (ctx) =>
        ctx.upgrade({
          open(ws) {
            ws.send("hello");
          },
          message(ws, msg) {
            ws.send(`echo:${typeof msg === "string" ? msg : "binary"}`);
          },
        }),
    }),
  ],
});
