// manage() for the runtime pieces of @miujs/migrate: the strangler proxy and contract capture.
import { describe, expect, test } from "bun:test";
import { miu, route, validate, type Context } from "miujs";
import { captureMiddleware, memorySink } from "../src/capture.ts";
import { bridgeAuth } from "../src/bridge.ts";
import { migrateProxy, NOT_PORTED_TAG } from "../src/proxy.ts";

const ported = route.get("/ported", { handler: () => ({ servedBy: "miujs" }) });
const stub = route.get("/stub", { tags: [NOT_PORTED_TAG], handler: () => ({}) });

/** A fake old app: /fail answers 500, /hang never answers (until aborted), anything else 200. */
function oldApp() {
  return async (req: Request) => {
    const path = new URL(req.url).pathname.replace(/^\/legacy/, "");
    if (path === "/down") throw new TypeError("connection refused");
    if (path === "/hang") return new Promise<Response>((_, reject) => req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    if (path === "/fail") return new Response("boom", { status: 500 });
    return new Response("old", { status: 200 });
  };
}

function setup(opts: Partial<Parameters<typeof migrateProxy>[0]> = {}) {
  const proxy = migrateProxy({ upstream: "http://old-app.internal:8000/legacy", fetch: oldApp(), headers: { "x-proxy-secret": "shared-secret-value" }, ...opts });
  let grabbed: Context | undefined;
  const app = miu({ logLevel: "silent", routes: [ported, stub, route.get("/__ctx", { handler: (c) => void (grabbed = c as unknown as Context) })], plugins: [proxy] });
  const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));
  const section = () => proxy.manage!().find((s) => s.id === "proxy")!;
  const ctx = async () => (await get("/__ctx"), grabbed!);
  return { app, proxy, get, section, ctx };
}

describe("migrateProxy manage()", () => {
  test("status counts served, proxied, failed and timed-out requests; never shows extra header values", async () => {
    const s = setup({ timeout: 50 });
    expect(s.proxy.manage!().map((x) => x.id)).toEqual(["proxy"]);
    await s.get("/ported");
    await s.get("/ported");
    await s.get("/stub");
    await s.get("/old-page");
    await s.get("/fail");
    await s.get("/down");
    await s.get("/hang");
    const st = await s.section().status!(await s.ctx());
    const v = (label: string) => st.stats!.find((x) => x.label === label)?.value;
    expect(v("Upstream")).toBe("http://old-app.internal:8000/legacy");
    expect(v("Served by MiuJS")).toBe(3); // /ported twice + the /__ctx probe
    expect(v("Proxied")).toBe(5);
    expect(v("Upstream 5xx")).toBe(1);
    expect(v("Upstream unreachable")).toBe(1);
    expect(v("Upstream timeouts")).toBe(1);
    expect(v("Timeout (ms)")).toBe(50);
    expect(v("Extra headers")).toBe("x-proxy-secret");
    expect(JSON.stringify(st)).not.toContain("shared-secret-value");
  });

  test("settings: timeout is validated and applies to the next request", async () => {
    const s = setup({ timeout: 5_000 });
    const settings = s.section().settings!;
    const ctx = await s.ctx();
    expect(await settings.get(ctx)).toEqual({ timeout: 5_000 });
    for (const bad of [{ timeout: 0 }, { timeout: 99 }, { timeout: 600_001 }, { timeout: 1.5 }, { timeout: "100" }]) expect(validate(settings.schema, bad).ok).toBe(false);
    await settings.set({ timeout: 100 }, ctx);
    expect(await settings.get(ctx)).toEqual({ timeout: 100 });
    const started = performance.now();
    const res = await s.get("/hang");
    expect(res.status).toBe(504);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("captureMiddleware manage()", () => {
  function capture(opts: Partial<Parameters<typeof captureMiddleware>[0]> = {}) {
    const sink = memorySink();
    const plugin = captureMiddleware({ sink, ...opts });
    let grabbed: Context | undefined;
    const app = miu({
      logLevel: "silent",
      routes: [ported, route.get("/__ctx", { handler: (c) => void (grabbed = c as unknown as Context) })],
      plugins: [plugin, migrateProxy({ upstream: "http://old.internal", fetch: oldApp() })],
    });
    const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));
    const section = plugin.manage!().find((x) => x.id === "capture")!;
    return { app, sink, plugin, get, section, ctx: async () => (await get("/__ctx"), grabbed!) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test("status counts recorded exchanges and failed writes", async () => {
    let fail = false;
    const sink = memorySink();
    const c = capture({ sink: { write: (e) => (fail ? Promise.reject(new Error("disk full")) : sink.write(e)) } });
    const ctx = await c.ctx();
    await c.get("/ported");
    await c.get("/old");
    await settle();
    fail = true;
    await c.get("/old");
    await settle();
    const st = await c.section.status!(ctx);
    const v = (label: string) => st.stats!.find((x) => x.label === label)?.value;
    expect(v("Recorded")).toBe(3); // the ctx probe, /ported and the first /old
    expect(v("Failed writes")).toBe(1);
    expect(v("Sample")).toBe(1);
    expect(v("Recording")).toBe("all");
  });

  test("settings: sample and only are validated and apply now", async () => {
    const c = capture();
    const settings = c.section.settings!;
    const ctx = await c.ctx();
    await settle();
    expect(await settings.get(ctx)).toEqual({ sample: 1, only: "all" });
    for (const bad of [{ sample: -0.1, only: "all" }, { sample: 1.5, only: "all" }, { sample: 1, only: "some" }]) expect(validate(settings.schema, bad).ok).toBe(false);
    const before = c.sink.entries.length;
    await settings.set({ sample: 0, only: "all" }, ctx);
    await c.get("/ported");
    await settle();
    expect(c.sink.entries.length).toBe(before);
    await settings.set({ sample: 1, only: "proxied" }, ctx);
    await c.get("/ported");
    await c.get("/old");
    await settle();
    expect(c.sink.entries.slice(before).map((e) => e.path)).toEqual(["/old"]);
  });

  test("a custom sample function is not overridable; only `only` is a setting then", async () => {
    const c = capture({ sample: () => true });
    const ctx = await c.ctx();
    expect(await c.section.settings!.get(ctx)).toEqual({ only: "all" });
    expect(validate(c.section.settings!.schema, { only: "proxied" }).ok).toBe(true);
    expect((await c.section.status!(ctx)).stats!.find((x) => x.label === "Sample")!.value).toBe("custom");
  });
});

describe("bridgeAuth manage()", () => {
  test("status counts sign-ins through the old app's session, unknown users and blocked cross-site writes", async () => {
    const from = {
      kind: "laravel" as const,
      async read(ctx: Context) {
        const id = ctx.headers.get("x-legacy");
        return id ? { kind: "laravel" as const, id: "sess-secret-id", data: { secret: "legacy-session-data" }, userId: id } : null;
      },
      login: async () => ({ kind: "laravel" as const, id: "s", data: {}, userId: "1" }),
      logout: async () => {},
      inspect: () => ({ kind: "laravel", appKey: "(set)" }),
    };
    const plugin = bridgeAuth({ from, findUser: (id) => (id === "1" ? { id: "1", roles: [] } : null) });
    let grabbed: Context | undefined;
    const app = miu({
      logLevel: "silent",
      routes: [route.get("/me", { auth: "optional", handler: (c) => ({ id: c.user?.id ?? null }) }), route.post("/write", { handler: () => ({}) }), route.get("/__ctx", { handler: (c) => void (grabbed = c as unknown as Context) })],
      plugins: [plugin],
    });
    await app.fetch(new Request("http://localhost/me", { headers: { "x-legacy": "1" } }));
    await app.fetch(new Request("http://localhost/me", { headers: { "x-legacy": "1" } }));
    await app.fetch(new Request("http://localhost/me", { headers: { "x-legacy": "999" } }));
    await app.fetch(new Request("http://localhost/write", { method: "POST", headers: { "x-legacy": "1", origin: "https://evil.example" } }));
    await app.fetch(new Request("http://localhost/__ctx"));
    const sections = plugin.manage!();
    expect(sections.map((x) => x.id)).toEqual(["bridge-auth"]);
    const st = await sections[0].status!(grabbed!);
    const v = (label: string) => st.stats!.find((x) => x.label === label)?.value;
    expect(v("Signed in via old session")).toBe(2);
    expect(v("Old-session users not found")).toBe(1);
    expect(v("Cross-site writes blocked")).toBe(1);
    expect(v("Source")).toBe("laravel");
    expect(JSON.stringify(st)).not.toMatch(/sess-secret-id|legacy-session-data/);
  });
});
