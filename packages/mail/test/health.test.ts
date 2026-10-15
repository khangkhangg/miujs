// Memory, hang and exit health of @miujs/mail: the dev outbox stays bounded, background sends are
// waited for by app.drain(), hung providers time out, and nothing keeps the process alive.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { consoleTransport, httpTransport, mail, resendTransport } from "../src/index.ts";

const PKG = join(import.meta.dir, "..");

let hung: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  hung = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
});
afterAll(() => hung.stop(true));

test("the console outbox stays bounded under many sends", async () => {
  const transport = consoleTransport({ log: () => {} });
  const app = miu({
    logLevel: "silent",
    dev: true,
    plugins: [mail({ transport, from: "App <app@example.com>" })],
    routes: [route.post("/signup", { handler: async ({ mail }) => mail.send({ to: "a@example.com", subject: "Hi", html: "<p>Welcome</p>" }) })],
  });
  const r = await leakCheck("console mail", async () => void (await (await app.fetch(new Request("http://x.test/signup", { method: "POST" }))).arrayBuffer()), {
    perRound: 3000,
    rounds: 6,
    warmup: 1000,
  });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
  expect(transport.outbox.length).toBe(50);
}, 120_000);

test("background sends (ctx.waitUntil) are awaited by app.drain()", async () => {
  let delivered = 0;
  const slow = { kind: "slow", send: async () => void (await Bun.sleep(20), delivered++) };
  const app = miu({
    logLevel: "silent",
    dev: true,
    plugins: [mail({ transport: slow, from: "app@example.com" })],
    routes: [route.post("/x", { handler: (ctx) => (ctx.waitUntil(ctx.mail.send({ to: "a@example.com", subject: "s", text: "t" })), "ok") })],
  });
  for (let i = 0; i < 5; i++) await (await app.fetch(new Request("http://x.test/x", { method: "POST" }))).text();
  await app.drain();
  expect(delivered).toBe(5);
});

test("a provider that never answers times out instead of hanging the send", async () => {
  const url = `http://127.0.0.1:${hung.port}`;
  const resend = resendTransport({ apiKey: "re_test", baseUrl: url, timeoutMs: 100 });
  const http = httpTransport({ url, map: (m) => m, timeoutMs: 100 });
  const msg = { id: "1", from: "a@example.com", to: ["b@example.com"], subject: "s", text: "t", headers: {}, createdAt: 0 };
  for (const t of [resend, http]) {
    const t0 = performance.now();
    await expect(t.send(msg, {})).rejects.toMatchObject({ code: "MIU_E_MAIL_TIMEOUT" });
    expect(performance.now() - t0).toBeLessThan(1000);
  }
});

test("memoryTransport.waitFor does not keep the process alive once satisfied", async () => {
  const r = await exitCheck(`
    import { memoryTransport } from "../src/index.ts";
    const t = memoryTransport();
    const p = t.waitFor(1, 30_000);
    await t.send({ id: "1", from: "a@example.com", to: ["b@example.com"], subject: "s", text: "t", headers: {}, createdAt: 0 });
    await p;
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);

test("an app using mail() exits after sends, and after listen + stop", async () => {
  const r = await exitCheck(`
    import { miu, route } from "miujs";
    import { mail, consoleTransport } from "../src/index.ts";
    const app = miu({ logLevel: "silent", plugins: [mail({ transport: consoleTransport({ log: () => {} }), from: "app@example.com" })],
      routes: [route.post("/x", { handler: (ctx) => (ctx.waitUntil(ctx.mail.send({ to: "a@example.com", subject: "s", text: "t" })), "ok") })] });
    await app.ready();
    await (await app.fetch(new Request("http://x/x", { method: "POST" }))).text();
    const s = await app.listen(0, "127.0.0.1");
    await (await fetch(new URL("/x", s.url), { method: "POST" })).text();
    await app.drain();
    await s.stop();
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);
