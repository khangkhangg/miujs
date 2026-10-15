import { expect, test } from "bun:test";
import { definePlugin, miu, route } from "../src/index.ts";

test("onRequest runs for unmatched requests, with ctx.route null (proxies rely on this)", async () => {
  const seen: (string | null)[] = [];
  const app = miu({
    routes: [route.get("/known", { handler: () => "k" })],
    plugins: [definePlugin({ name: "proxy", onRequest: (ctx) => { seen.push(ctx.route?.name ?? null); if (!ctx.route) return new Response("from upstream"); } })],
  });
  expect(await (await app.fetch(new Request("http://localhost/unknown"))).text()).toBe("from upstream");
  expect(await (await app.fetch(new Request("http://localhost/known"))).text()).toBe("k");
  expect(seen).toEqual([null, "get_known"]);
});

test("cookies.set with encode: false sends the value as is", async () => {
  const app = miu({ routes: [route.get("/c", { handler: (ctx) => { ctx.cookies.set("sessionid", "abc:def:ghi", { encode: false }); return "ok"; } })] });
  const res = await app.fetch(new Request("http://localhost/c"));
  expect(res.headers.get("set-cookie")).toStartWith("sessionid=abc:def:ghi;");
});

test("cookies.set with encode: false still refuses characters that would break the header", async () => {
  const app = miu({ logLevel: "silent", routes: [route.get("/c", { handler: (ctx) => { ctx.cookies.set("x", "a;b", { encode: false }); return "ok"; } })] });
  const res = await app.fetch(new Request("http://localhost/c"));
  expect(res.status).toBe(500);
});
