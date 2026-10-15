import { afterAll, describe, expect, test } from "bun:test";
import { Miu, t } from "../src/index.ts";
import { serve } from "../src/adapters/node.ts";

const app = new Miu()
  .get("/hi/:name", (c) => ({ hi: c.params.name }))
  .post("/echo", { body: t.object({ a: t.integer() }) }, (c) => c.body)
  .get("/cookie", (c) => {
    c.setCookie("a", "1");
    c.setCookie("b", "2");
    return "ok";
  });

const server = await serve(app, { port: 0 });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.close());

describe("Node adapter", () => {
  test("serves GET with params", async () => {
    const res = await fetch(`${base}/hi/ann`);
    expect(await res.json()).toEqual({ hi: "ann" });
  });

  test("forwards request bodies", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 3 }),
    });
    expect(await res.json()).toEqual({ a: 3 });
  });

  test("preserves multiple set-cookie headers", async () => {
    const res = await fetch(`${base}/cookie`);
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });
});

test("c.ip is the socket address on the Node adapter", async () => {
  const ipApp = new Miu().get("/ip", (c) => ({ ip: c.ip ?? null }));
  const s = await serve(ipApp, { port: 0, hostname: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/ip`, { headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(await res.json()).toEqual({ ip: "127.0.0.1" });
  } finally {
    await s.close();
  }
});
