import { expect, test } from "bun:test";
import { definePlugin, miu, route } from "../src/index.ts";

test("app.close() calls every plugin's stop() once, in reverse order", async () => {
  const calls: string[] = [];
  const app = miu({
    plugins: [definePlugin({ name: "a", stop: () => void calls.push("a") }), definePlugin({ name: "b", stop: async () => void calls.push("b") }), definePlugin({ name: "c" })],
  });
  await app.ready();
  await app.close();
  await app.close();
  expect(calls).toEqual(["b", "a"]);
});

test("stopping a listening server also stops plugins, after the server closes", async () => {
  const calls: string[] = [];
  const app = miu({ logLevel: "silent", routes: [route.get("/", { handler: () => "ok" })], plugins: [definePlugin({ name: "p", stop: () => void calls.push("stopped") })] });
  const s = await app.listen(0, "127.0.0.1");
  await fetch(s.url);
  await s.stop();
  expect(calls).toEqual(["stopped"]);
});

test("a failing plugin stop() doesn't prevent the others", async () => {
  const calls: string[] = [];
  const app = miu({
    logLevel: "silent",
    plugins: [definePlugin({ name: "ok", stop: () => void calls.push("ok") }), definePlugin({ name: "bad", stop: () => { throw new Error("boom"); } })],
  });
  await app.ready();
  await app.close();
  expect(calls).toEqual(["ok"]);
});

test("app.close() also waits for waitUntil work", async () => {
  let done = false;
  const app = miu({ routes: [route.get("/w", { handler: (ctx) => { ctx.waitUntil(new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 20))); return "ok"; } })] });
  await app.fetch(new Request("http://localhost/w"));
  await app.close();
  expect(done).toBe(true);
});
