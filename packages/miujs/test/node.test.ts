import { afterAll, beforeAll, expect, test } from "bun:test";
import { miu, route, t } from "../src/index.ts";
import { serveNode } from "../src/node.ts";

const app = miu({
  logLevel: "silent",
  routes: [
    route.get("/hi", { handler: () => ({ hi: true }) }),
    route.post("/echo", { body: t.object({ text: t.string() }), handler: ({ body }) => ({ text: body.text }) }),
    route.get("/cookies", {
      handler: (ctx) => {
        ctx.cookies.set("a", "1");
        ctx.cookies.set("b", "2");
        return "ok";
      },
    }),
  ],
});

let server: Awaited<ReturnType<typeof serveNode>>;
beforeAll(async () => {
  server = await serveNode(app, { port: 0, hostname: "127.0.0.1" });
});
afterAll(() => server.stop());

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

test("serves JSON over node:http", async () => {
  const res = await fetch(url("/hi"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ hi: true });
});

test("streams request bodies into the app", async () => {
  const res = await fetch(url("/echo"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "xin chào" }) });
  expect(await res.json()).toEqual({ text: "xin chào" });
});

test("keeps multiple Set-Cookie headers separate", async () => {
  const res = await fetch(url("/cookies"));
  const cookies = res.headers.getSetCookie();
  expect(cookies.length).toBe(2);
  expect(cookies[0]).toStartWith("a=1");
  expect(cookies[1]).toStartWith("b=2");
});

test("reports the real port when asked for port 0", () => {
  expect(server.port).toBeGreaterThan(0);
});

test("the Node adapter refuses an oversized chunked body with 413", async () => {
  const small = miu({ logLevel: "silent", maxBodySize: 64, routes: [route.post("/echo", { body: t.object({ text: t.string() }), handler: ({ body }) => ({ text: body.text }) })] });
  const s = await serveNode(small, { port: 0, hostname: "127.0.0.1" });
  try {
    const big = JSON.stringify({ text: "x".repeat(500) });
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await fetch(`http://127.0.0.1:${s.port}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  } finally {
    await s.stop();
  }
});

test("listen() caps Bun request bodies at the app limit", () => {
  const capApp = miu({ maxBodySize: 1000, routes: [route.post("/big", { maxBodySize: 5000, handler: () => "ok" })] });
  expect(capApp.maxRequestBodySize).toBe(5000);
});
