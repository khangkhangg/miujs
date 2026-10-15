import { expect, test } from "bun:test";
import { miu, route } from "../src/index.ts";

const ipRoute = route.get("/ip", { handler: (ctx) => ({ ip: ctx.ip ?? null }) });
const ip = async (app: ReturnType<typeof miu>, headers: Record<string, string>) =>
  (await (await app.fetch(new Request("http://localhost/ip", { headers }))).json()).ip;

test("without trustProxy, forwarding headers are ignored", async () => {
  const app = miu({ routes: [ipRoute] });
  expect(await ip(app, { "x-forwarded-for": "6.6.6.6" })).toBeNull();
});

test("X-Forwarded-For uses the rightmost address (the one our proxy appended), not the client-supplied left", async () => {
  const app = miu({ trustProxy: { header: "x-forwarded-for" }, routes: [ipRoute] });
  expect(await ip(app, { "x-forwarded-for": "6.6.6.6, 203.0.113.7" })).toBe("203.0.113.7");
});

test("hops skips that many trusted proxies from the right", async () => {
  const app = miu({ trustProxy: { header: "x-forwarded-for", hops: 2 }, routes: [ipRoute] });
  expect(await ip(app, { "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" })).toBe("203.0.113.7");
});

test("single-value headers such as x-real-ip are used as is", async () => {
  const app = miu({ trustProxy: { header: "x-real-ip" }, routes: [ipRoute] });
  expect(await ip(app, { "x-real-ip": "198.51.100.4" })).toBe("198.51.100.4");
});

test("too few entries for the configured hops gives no IP rather than a forged one", async () => {
  const app = miu({ trustProxy: { header: "x-forwarded-for", hops: 2 }, routes: [ipRoute] });
  expect(await ip(app, { "x-forwarded-for": "6.6.6.6" })).toBeNull();
});
