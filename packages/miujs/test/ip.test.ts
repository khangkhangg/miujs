import { expect, test } from "bun:test";
import { miu, route } from "../src/index.ts";

const app = miu({ logLevel: "silent", routes: [route.get("/ip", { handler: (ctx) => ({ ip: ctx.ip ?? null }) })] });

test("on Bun, ctx.ip is the socket's address", async () => {
  const server = await app.listen(0, "127.0.0.1");
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/ip`);
    expect((await res.json()).ip).toBe("127.0.0.1");
  } finally {
    await server.stop();
  }
});

test("a client-sent cf-connecting-ip header is ignored outside Workers", async () => {
  const res = await app.fetch(new Request("http://localhost/ip", { headers: { "cf-connecting-ip": "6.6.6.6" } }));
  expect((await res.json()).ip).toBeNull();
});

test("on Workers, ctx.ip comes from cf-connecting-ip (set by Cloudflare)", async () => {
  const res = await app.dispatch(new Request("http://localhost/ip", { headers: { "cf-connecting-ip": "203.0.113.9" } }), {}, { runtime: "workerd" });
  expect((await res.json()).ip).toBe("203.0.113.9");
});

test("through the Node adapter, ctx.ip is the socket's address", async () => {
  const { serveNode } = await import("../src/node.ts");
  const server = await serveNode(app, { port: 0, hostname: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/ip`);
    expect((await res.json()).ip).toMatch(/127\.0\.0\.1$/);
  } finally {
    await server.stop();
  }
});
