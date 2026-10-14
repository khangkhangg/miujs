import { afterAll, expect, test } from "bun:test";
import { Miu } from "../src/index.ts";

// Guards for hot-path shortcuts: what clients receive on the wire must not change.
const app = new Miu({ logger: false })
  .get("/text", () => "Hi")
  .get("/json/:id", (c) => ({ id: c.params.id }))
  .get("/status", (c) => {
    c.status(201);
    return "made";
  })
  .get("/header", (c) => {
    c.header("x-a", "1");
    return "h";
  });
const server = Bun.serve({ port: 0, fetch: app.fetch });
afterAll(() => server.stop(true));
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

test("text from a middleware-free route has text/plain on the wire", async () => {
  const res = await fetch(url("/text"));
  expect(res.headers.get("content-type")).toMatch(/^text\/plain;\s?charset=utf-8$/i);
  expect(await res.text()).toBe("Hi");
});

test("in-process requests still see an explicit content-type", async () => {
  expect((await app.request("/text")).headers.get("content-type")).toContain("text/plain");
});

test("status and custom headers survive the fast path", async () => {
  const s = await fetch(url("/status"));
  expect(s.status).toBe(201);
  expect(await s.text()).toBe("made");
  const h = await fetch(url("/header"));
  expect(h.headers.get("x-a")).toBe("1");
  expect(h.headers.get("content-type")).toContain("text/plain");
});

test("json fast path", async () => {
  const res = await fetch(url("/json/7"));
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toEqual({ id: "7" });
});
