import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { CLIENT_JS, CLIENT_JS_HASH } from "../src/client-bundle.ts";
import { buildClient } from "../scripts/build-client.ts";
import { defineRoom, rooms, t } from "../src/index.ts";

const chat = defineRoom("chat", { state: t.object({}), init: () => ({}) });

describe("browser client bundle", () => {
  test("is up to date with src/client.ts (run scripts/build-client.ts after changing the client)", async () => {
    const fresh = await buildClient();
    expect(fresh.js).toBe(CLIENT_JS);
    expect(fresh.hash).toBe(CLIENT_JS_HASH);
  });

  test("has no node: imports and exports connect()", async () => {
    expect(CLIENT_JS).not.toContain("node:");
    expect(CLIENT_JS).not.toMatch(/\bimport\s*[{(*"']/);
    const mod = await import(`data:text/javascript;base64,${btoa(CLIENT_JS)}`);
    expect(typeof mod.connect).toBe("function");
  });
});

describe("GET /rooms/_client.js", () => {
  const plugin = rooms({ rooms: [chat] });
  const app = miu({ plugins: [plugin], logLevel: "silent" });

  test("the stable URL revalidates; the hashed URL is immutable", async () => {
    const r = await app.request("/rooms/_client.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("etag")).toBe(`"${CLIENT_JS_HASH}"`);
    expect(await r.text()).toBe(CLIENT_JS);
    expect(plugin.clientPath).toBe(`/rooms/_client/${CLIENT_JS_HASH}.js`);
    const h = await app.request(plugin.clientPath);
    expect(h.status).toBe(200);
    expect(h.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await app.request("/rooms/_client/deadbeef.js")).status).toBe(404);
  });

  test("If-None-Match gives 304", async () => {
    const r = await app.request("/rooms/_client.js", { headers: { "if-none-match": `"${CLIENT_JS_HASH}"` } });
    expect(r.status).toBe(304);
  });

  test("room joins still route", async () => {
    expect((await app.request("/rooms/chat/r1")).status).toBe(426);
  });
});
