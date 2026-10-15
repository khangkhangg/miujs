import { describe, expect, test } from "bun:test";
import { miu, route, validate } from "miujs";
import { cloudflareBindingStore, kvStore, memoryStore, rateLimit, type RateLimitOptions } from "../src/index.ts";
import { fakeKv } from "./fakes.ts";
import { actionOf, checkContract, listOf, manageCtx, run, section, stat } from "./manage-helpers.ts";

const S = 1000;
const T0 = 1_000 * 60 * S;

const items = route.get("/api/items", { name: "items", handler: () => ({ items: [] }) });
const login = route.post("/login", { name: "login", handler: () => ({ ok: true }) });

function setup(opts: Partial<RateLimitOptions> = {}) {
  const clock = { now: T0 };
  const store = opts.store ?? memoryStore();
  const plugin = rateLimit({
    now: () => clock.now,
    store,
    rules: [
      { name: "api", match: { path: "/api/*" }, limit: 2, window: "1m" },
      { name: "login", match: { route: "login" }, limit: 5, window: "15m", algorithm: "fixed" },
    ],
    ...opts,
  });
  const app = miu({ routes: [items, login], plugins: [plugin], logLevel: "silent" });
  const send = (path: string, ip = "1.1.1.1", method = "GET") =>
    app.dispatch(new Request(`http://localhost${path}`, { method, headers: { "cf-connecting-ip": ip } }), {}, { runtime: "workerd" }) as Promise<Response>;
  return { plugin, app, send, clock, store };
}


describe("rateLimit manage()", () => {
  test("has one valid 'ratelimit' section", () => {
    const sections = setup().plugin.manage!();
    checkContract(sections);
    expect(sections.map((s) => s.id)).toEqual(["ratelimit"]);
  });

  test("status counts checks, rejections, tracked keys and describes rules", async () => {
    const { plugin, send } = setup();
    await send("/api/items");
    await send("/api/items");
    await send("/api/items"); // 429
    await send("/api/items", "2.2.2.2");
    const ctx = await manageCtx(plugin);
    const { stats, tables } = await section(plugin, "ratelimit").status!(ctx);
    expect(stat(stats, "Store")?.value).toBe("memory");
    expect(stat(stats, "Rules")?.value).toBe(2);
    expect(stat(stats, "Keys tracked")?.value).toBe(2);
    expect(stat(stats, "Rejected")?.value).toBe(1);
    expect(stat(stats, "Rejected")?.tone).toBe("warning");
    expect(stat(stats, "Store errors")?.value).toBe(0);
    expect(tables![0].rows).toEqual([
      { name: "api", match: "path /api/*", limit: 2, window: "1m", algorithm: "sliding", by: "ip", rejected: 1 },
      { name: "login", match: "route login", limit: 5, window: "15m", algorithm: "fixed", by: "ip", rejected: 0 },
    ]);
  });

  test("status on a non-enumerable store says keys are not countable", async () => {
    const kv = fakeKv(() => T0);
    const { plugin } = setup({ store: kvStore("RL") });
    const ctx = await manageCtx(plugin, { RL: kv }, "workerd");
    const { stats } = await section(plugin, "ratelimit").status!(ctx);
    expect(stat(stats, "Store")?.value).toBe("kv:RL");
    expect(stat(stats, "Keys tracked")?.value).toBeNull();
    expect(stat(stats, "Keys tracked")?.hint).toMatch(/not countable/);
    expect(stat(stats, "Rejected")?.tone).toBeUndefined();
  });

  test("store errors are counted", async () => {
    const { plugin, send } = setup({ store: kvStore("RL"), onStoreError: "allow" });
    expect((await send("/api/items")).status).toBe(200); // no RL binding
    const ctx = await manageCtx(plugin);
    const { stats } = await section(plugin, "ratelimit").status!(ctx);
    expect(stat(stats, "Store errors")?.value).toBe(1);
    expect(stat(stats, "Store errors")?.tone).toBe("critical");
  });

  test("settings get the effective limits and set them live", async () => {
    const { plugin, send } = setup();
    const settings = section(plugin, "ratelimit").settings!;
    const ctx = await manageCtx(plugin);
    expect(await settings.get(ctx)).toEqual({ api: { limit: 2, window: "1m" }, login: { limit: 5, window: "15m" } });
    const value = { api: { limit: 3, window: "30s" }, login: { limit: 6, window: "1h" } };
    expect(validate(settings.schema, value).ok).toBe(true);
    await settings.set(value, ctx);
    expect(await settings.get(ctx)).toEqual(value);
    expect([(await send("/api/items")).status, (await send("/api/items")).status, (await send("/api/items")).status, (await send("/api/items")).status]).toEqual([200, 200, 200, 429]);
    const { tables } = await section(plugin, "ratelimit").status!(ctx);
    expect(tables![0].rows[0]).toMatchObject({ limit: 3, window: "30s" });
    expect((plugin.inspect!() as any).rules[0]).toMatchObject({ limit: 3, window: "30s", windowSeconds: 30 });
  });

  test("settings schema rejects bad limits, windows and missing rules", () => {
    const { plugin } = setup();
    const { schema } = section(plugin, "ratelimit").settings!;
    expect(validate(schema, { api: { limit: 0, window: "1m" }, login: { limit: 5, window: "15m" } }).ok).toBe(false);
    expect(validate(schema, { api: { limit: 1.5, window: "1m" }, login: { limit: 5, window: "15m" } }).ok).toBe(false);
    expect(validate(schema, { api: { limit: 2, window: "soon" }, login: { limit: 5, window: "15m" } }).ok).toBe(false);
    expect(validate(schema, { api: { limit: 2, window: "0s" }, login: { limit: 5, window: "15m" } }).ok).toBe(false);
    expect(validate(schema, { api: { limit: 2, window: "1m" } }).ok).toBe(false);
  });

  test("set() rejects a policy the store cannot enforce and changes nothing", async () => {
    const store = cloudflareBindingStore("CF", { limit: 2, period: 60 });
    const { plugin } = setup({ store, rules: [{ name: "api", limit: 2, window: "1m", algorithm: "fixed" }] });
    const settings = section(plugin, "ratelimit").settings!;
    const ctx = await manageCtx(plugin, { CF: { limit: async () => ({ success: true }) } });
    await expect(Promise.resolve(settings.set({ api: { limit: 10, window: "1m" } }, ctx))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/configured for 2 per 60/) });
    expect(await settings.get(ctx)).toEqual({ api: { limit: 2, window: "1m" } });
  });

  test("set() is all-or-nothing across rules", async () => {
    const { plugin } = setup({ rules: [
      { name: "a", limit: 2, window: "1m" },
      { name: "b", limit: 4, window: "1m", algorithm: "token-bucket", cost: 3 },
    ] });
    const settings = section(plugin, "ratelimit").settings!;
    const ctx = await manageCtx(plugin);
    // cost 3 > new limit 2 for "b"
    await expect(Promise.resolve(settings.set({ a: { limit: 9, window: "1m" }, b: { limit: 2, window: "1m" } }, ctx))).rejects.toThrow(/cost/);
    expect(await settings.get(ctx)).toEqual({ a: { limit: 2, window: "1m" }, b: { limit: 4, window: "1m" } });
  });

  test("resetKey forgets one client's counter for a rule", async () => {
    const { plugin, send } = setup();
    await send("/api/items");
    await send("/api/items");
    expect((await send("/api/items")).status).toBe(429);
    const ctx = await manageCtx(plugin);
    const reset = actionOf(section(plugin, "ratelimit"), "resetKey");
    expect(await run(reset, { rule: "api", identity: "ip:1.1.1.1" }, ctx)).toBe('Reset "ip:1.1.1.1" for rule "api".');
    expect((await send("/api/items")).status).toBe(200);
    expect(await run(reset, { rule: "api", identity: "ip:1.1.1.1" }, ctx)).toMatch(/Reset/);
    expect(validate(reset.input!, { rule: "nope", identity: "ip:1" }).ok).toBe(false);
    expect(validate(reset.input!, { rule: "api", identity: "" }).ok).toBe(false);
  });

  test("resetKey explains when the store cannot reset", async () => {
    const store = cloudflareBindingStore("CF", { limit: 2, period: 60 });
    const { plugin } = setup({ store, rules: [{ name: "api", limit: 2, window: "1m", algorithm: "fixed" }] });
    const ctx = await manageCtx(plugin, { CF: { limit: async () => ({ success: true }) } });
    await expect(run(actionOf(section(plugin, "ratelimit"), "resetKey"), { rule: "api", identity: "ip:1" }, ctx)).rejects.toThrow(/cannot reset/);
  });

  test("keys list shows limited clients (memory store), pages, and resets a row", async () => {
    const { plugin, send, clock } = setup();
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      await send("/api/items", ip);
      await send("/api/items", ip);
    }
    await send("/api/items", "4.4.4.4"); // not limited
    const ctx = await manageCtx(plugin);
    const keys = listOf(section(plugin, "ratelimit"), "keys");
    const p1 = await keys.list({ limit: 2, filters: { state: "limited" } }, ctx);
    expect(p1.rows.length).toBe(2);
    expect(p1.rows[0]).toEqual({ key: "api:ip:1.1.1.1", rule: "api", identity: "ip:1.1.1.1", limited: true, expiresAt: expect.any(String) });
    const p2 = await keys.list({ limit: 2, cursor: p1.next, filters: { state: "limited" } }, ctx);
    expect(p2.rows.map((r) => r.identity)).toEqual(["ip:3.3.3.3"]);
    expect(p2.next).toBeUndefined();
    const all = await keys.list({ limit: 10, filters: { state: "all" } }, ctx);
    expect(all.rows.map((r) => r.identity)).toContain("ip:4.4.4.4");
    expect((await keys.list({ limit: 10 }, ctx)).rows.length).toBe(3); // default: limited only
    expect((await keys.list({ limit: 10, search: "2.2" }, ctx)).rows.map((r) => r.identity)).toEqual(["ip:2.2.2.2"]);

    const reset = actionOf(keys, "reset");
    expect(await run(reset, { id: "api:ip:2.2.2.2" }, ctx)).toMatch(/Reset/);
    expect((await send("/api/items", "2.2.2.2")).status).toBe(200);
    await expect(run(reset, { id: "ghost:ip:1" }, ctx)).rejects.toThrow(/No rule/);

    clock.now += 10 * 60 * S; // every window passed
    expect((await keys.list({ limit: 10, filters: { state: "all" } }, ctx)).rows).toEqual([]);
  });

  test("keys list explains when the store cannot list", async () => {
    const { plugin } = setup({ store: kvStore("RL") });
    const ctx = await manageCtx(plugin, { RL: fakeKv(() => T0) }, "workerd");
    await expect(Promise.resolve(listOf(section(plugin, "ratelimit"), "keys").list({ limit: 10 }, ctx))).rejects.toThrow(/cannot list/);
  });

  test("keys list caps the page size at 100", async () => {
    const { plugin, send } = setup();
    for (let i = 0; i < 120; i++) await send("/api/items", `10.0.0.${i}`);
    const ctx = await manageCtx(plugin);
    const rows = (await listOf(section(plugin, "ratelimit"), "keys").list({ limit: 500, filters: { state: "all" } }, ctx)).rows;
    expect(rows.length).toBe(100);
  });

  test("API keys stay hashed in the list", async () => {
    const { plugin, app } = setup({ keyBy: "apiKey" });
    await app.dispatch(new Request("http://localhost/api/items", { headers: { "x-api-key": "sk_live_supersecret" } }), {}, { runtime: "bun" });
    const ctx = await manageCtx(plugin);
    const page = await listOf(section(plugin, "ratelimit"), "keys").list({ limit: 10, filters: { state: "all" } }, ctx);
    // The hashed key's bucket, plus the client's IP bucket (an unverified key also counts per IP).
    expect(page.rows.length).toBe(2);
    expect(JSON.stringify(page)).not.toContain("supersecret");
  });
});
