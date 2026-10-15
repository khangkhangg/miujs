import { describe, expect, test } from "bun:test";
import { miu, route, validate } from "miujs";
import { bots, memoryBotStore, type BotCacheStore, type BotsOptions, type CachedResponse } from "../src/index.ts";
import { BLOCKED_LOG, ring } from "../src/manage.ts";
import { BROWSER_HEADERS, cfRequest } from "./helpers.ts";
import { actionOf, checkContract, listOf, manageCtx, run, section, stat } from "./manage-helpers.ts";

const BASE = "https://example.com";
const GPT = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" };
const CURL = { "user-agent": "curl/8.4.0" };
const GOOGLE = { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" };
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: BotsOptions = {}) {
  const clock = { now: 1_700_000_000_000 };
  const calls: Record<string, number> = {};
  const hit = (n: string) => (calls[n] = (calls[n] ?? 0) + 1);
  const plugin = bots({ now: () => clock.now, ...opts, cache: opts.cache === false ? false : { store: memoryBotStore({ now: () => clock.now }), ...(opts.cache ?? {}) } });
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [plugin],
    routes: [
      route.get("/posts/:id", { name: "post", handler: (c) => (hit("post"), { id: c.params.id, title: "T", body: "long" }) }),
      route.get("/blog/:slug", { name: "blog", handler: (c) => (hit("blog"), { slug: c.params.slug }) }),
    ],
  });
  const get = async (path: string, headers: Record<string, string> = GPT) => {
    const res = await app.fetch(new Request(BASE + path, { headers }));
    await res.arrayBuffer();
    await tick();
    return res;
  };
  return { plugin, app, get, clock, calls, ctx: () => manageCtx(plugin) };
}

const rowsOf = (tables: { title: string; rows: Record<string, unknown>[] }[] | undefined, title: string) => tables?.find((t) => t.title === title)?.rows;

describe("bots manage()", () => {
  test("has one valid 'bots' section", () => {
    const sections = bots().manage!();
    checkContract(sections);
    expect(sections.map((s) => s.id)).toEqual(["bots"]);
  });

  test("status: traffic by kind and decision, cache counters and store size", async () => {
    const { plugin, get, ctx } = setup({ policy: { bot: "block" } });
    await get("/posts/1", BROWSER_HEADERS);
    await get("/posts/1"); // miss, stored
    await get("/posts/1"); // hit
    await get("/posts/2", CURL); // blocked
    const c = await ctx(); // the helper's own request: one unknown visitor on an exempt route (full)
    const { stats, tables } = await section(plugin, "bots").status!(c);
    expect(rowsOf(tables, "Requests by kind")).toEqual([
      { kind: "human", requests: 1 },
      { kind: "search", requests: 0 },
      { kind: "ai", requests: 2 },
      { kind: "bot", requests: 1 },
      { kind: "unknown", requests: 1 },
    ]);
    expect(rowsOf(tables, "Decisions")).toEqual([
      { action: "full", requests: 2 },
      { action: "partial", requests: 0 },
      { action: "cached", requests: 2 },
      { action: "block", requests: 1 },
    ]);
    expect(stat(stats, "Cache store")?.value).toBe("memory");
    expect(stat(stats, "Cache hits")?.value).toBe(1);
    expect(stat(stats, "Cache misses")?.value).toBe(1);
    expect(stat(stats, "Hit rate")?.value).toBe("50%");
    expect(stat(stats, "Stale served")?.value).toBe(0);
    expect(stat(stats, "Stored")?.value).toBe(1);
    expect(stat(stats, "Wait timeouts")?.value).toBe(0);
    expect(stat(stats, "Cache entries")?.value).toBe(1);
    expect(stat(stats, "Cache size")?.value as number).toBeGreaterThan(0);
    expect(stat(stats, "Blocked")?.value).toBe(1);
  });

  test("status: stores that cannot count say so; a disabled cache says so", async () => {
    const custom = plainStore();
    const a = setup({ cache: { store: custom.store } });
    const sa = (await section(a.plugin, "bots").status!(await a.ctx())).stats;
    expect(stat(sa, "Cache entries")?.value).toBeNull();
    expect(stat(sa, "Cache entries")?.hint).toMatch(/not countable/);
    const b = setup({ cache: false });
    const sb = (await section(b.plugin, "bots").status!(await b.ctx())).stats;
    expect(stat(sb, "Cache store")?.value).toBe("off");
  });

  test("blocked list: newest first, with kind, name, country, path and reason", async () => {
    const { plugin, get, ctx, clock } = setup({ policy: { ai: "block" }, blockCountries: ["RU"], trustCloudflare: true });
    await get("/posts/1");
    clock.now += 1000;
    await get("/blog/x?token=secret", { ...BROWSER_HEADERS, "cf-ipcountry": "RU" });
    await get("/posts/2", BROWSER_HEADERS); // not blocked
    const list = listOf(section(plugin, "bots"), "blocked");
    const { rows, next } = await list.list({ limit: 10 }, await ctx());
    expect(next).toBeUndefined();
    expect(rows).toEqual([
      { at: new Date(clock.now).toISOString(), kind: "human", name: null, country: "RU", path: "/blog/x", reason: "country blocked" },
      { at: new Date(clock.now - 1000).toISOString(), kind: "ai", name: "GPTBot", country: null, path: "/posts/1", reason: "policy" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  test("blocked list: filters by kind, searches, pages, and keeps only the last BLOCKED_LOG", async () => {
    const { plugin, get, ctx } = setup({ policy: { ai: "block", bot: "block" } });
    for (let i = 0; i < BLOCKED_LOG + 10; i++) await get(`/posts/${i}`, i % 2 ? CURL : GPT);
    const c = await ctx();
    const list = listOf(section(plugin, "bots"), "blocked");
    const p1 = await list.list({ limit: 100 }, c);
    expect(p1.rows.length).toBe(100);
    expect(p1.rows[0].path).toBe(`/posts/${BLOCKED_LOG + 9}`);
    const p2 = await list.list({ limit: 100, cursor: p1.next }, c);
    expect(p2.rows.length).toBe(BLOCKED_LOG - 100);
    expect(p2.next).toBeUndefined();
    expect(p2.rows[p2.rows.length - 1].path).toBe("/posts/10"); // the 10 oldest were dropped
    const curls = await list.list({ limit: 100, filters: { kind: "bot" } }, c);
    expect(curls.rows.every((r) => r.name === "curl")).toBe(true);
    expect((await list.list({ limit: 100, search: "posts/20" }, c)).rows.map((r) => r.path)).toEqual(["/posts/209", "/posts/208", "/posts/207", "/posts/206", "/posts/205", "/posts/204", "/posts/203", "/posts/202", "/posts/201", "/posts/200", "/posts/20"]);
    expect((await list.list({ limit: 1000 }, c)).rows.length).toBe(100);
  });

  test("settings: get the effective values", async () => {
    const { plugin, ctx } = setup({ policy: { ai: "block" }, blockCountries: ["ru"], allowCountries: ["US", "VN"], botScoreThreshold: 20, cache: { ttl: 600 } });
    expect(await section(plugin, "bots").settings!.get(await ctx())).toEqual({
      policy: { human: "full", search: "cached", ai: "block", bot: "cached", unknown: "cached" },
      blockCountries: ["RU"],
      allowCountries: ["US", "VN"],
      botScoreThreshold: 20,
      cacheTtl: 600,
    });
  });

  test("settings: set() applies policy and countries at once", async () => {
    const { plugin, get, ctx } = setup({ trustCloudflare: true });
    const settings = section(plugin, "bots").settings!;
    const c = await ctx();
    const value = { ...(await settings.get(c)), policy: { human: "full", search: "cached", ai: "block", bot: "cached", unknown: "cached" }, blockCountries: ["cn"] };
    const parsed = validate(settings.schema, value);
    expect(parsed.ok).toBe(true);
    await settings.set((parsed as { value: unknown }).value, c);
    expect((await get("/posts/1")).status).toBe(403);
    expect((await get("/posts/1", { ...BROWSER_HEADERS, "cf-ipcountry": "CN" })).status).toBe(403);
    expect((await get("/posts/1", BROWSER_HEADERS)).status).toBe(200);
    expect((await settings.get(c) as { blockCountries: string[] }).blockCountries).toEqual(["CN"]);
    await settings.set({ ...value, blockCountries: [], allowCountries: ["VN"] }, c);
    expect((await get("/posts/1", { ...BROWSER_HEADERS, "cf-ipcountry": "CN" })).status).toBe(403);
    expect((await get("/posts/1", { ...BROWSER_HEADERS, "cf-ipcountry": "VN" })).status).toBe(200);
    await settings.set({ ...value, blockCountries: [], allowCountries: [] }, c); // empty = no restriction
    expect((await get("/posts/1", { ...BROWSER_HEADERS, "cf-ipcountry": "CN" })).status).toBe(200);
  });

  test("settings: cacheTtl applies to new entries", async () => {
    const { plugin, get, ctx, clock, calls } = setup();
    const settings = section(plugin, "bots").settings!;
    const c = await ctx();
    await settings.set({ ...(await settings.get(c)), cacheTtl: 60 }, c);
    await get("/posts/1");
    clock.now += 61_000;
    await get("/posts/1");
    expect(calls.post).toBe(2);
  });

  test("settings: botScoreThreshold applies to Cloudflare scores", async () => {
    const { plugin, app, ctx } = setup({ policy: { bot: "block" } });
    const settings = section(plugin, "bots").settings!;
    const c = await ctx();
    const send = () => app.dispatch(cfRequest(BASE + "/posts/1", BROWSER_HEADERS, { botManagement: { score: 40 } }), {}, { runtime: "workerd" }) as Promise<Response>;
    expect((await send()).status).toBe(200);
    await settings.set({ ...(await settings.get(c)), botScoreThreshold: 50 }, c);
    expect((await send()).status).toBe(403);
  });

  test("settings: the schema rejects bad values", async () => {
    const { plugin, ctx } = setup();
    const settings = section(plugin, "bots").settings!;
    const good = await settings.get(await ctx());
    const bad = (patch: Record<string, unknown>) => validate(settings.schema, { ...good, ...patch }).ok;
    expect(bad({})).toBe(true);
    expect(bad({ policy: { ...good.policy, ai: "nope" } })).toBe(false);
    expect(bad({ policy: { human: "full" } })).toBe(false);
    expect(bad({ blockCountries: ["USA"] })).toBe(false);
    expect(bad({ allowCountries: ["1"] })).toBe(false);
    expect(bad({ botScoreThreshold: 0 })).toBe(false);
    expect(bad({ botScoreThreshold: 100 })).toBe(false);
    expect(bad({ cacheTtl: 0 })).toBe(false);
    expect(bad({ cacheTtl: 1.5 })).toBe(false);
  });

  test("settings: no cacheTtl when the cache is off", async () => {
    const { plugin, ctx } = setup({ cache: false });
    const settings = section(plugin, "bots").settings!;
    expect(await settings.get(await ctx())).not.toHaveProperty("cacheTtl");
  });

  test("purgeCache: everything, or by path prefix", async () => {
    const { plugin, get, ctx, calls } = setup();
    await get("/posts/1");
    await get("/blog/a");
    await get("/blog/b");
    const c = await ctx();
    const purge = actionOf(section(plugin, "bots"), "purgeCache");
    expect(purge.danger).toBe(true);
    expect(await run(purge, { pathPrefix: "/blog/" }, c)).toBe('Purged 2 cached responses under "/blog/".');
    await get("/posts/1");
    expect(calls.post).toBe(1);
    await get("/blog/a");
    expect(calls.blog).toBe(3);
    expect(await run(purge, {}, c)).toBe("Purged 2 cached responses.");
    expect(await run(purge, {}, c)).toBe("Purged 0 cached responses.");
    expect(validate(purge.input!, { pathPrefix: "blog" }).ok).toBe(false);
  });

  test("purgeCache explains when the store cannot enumerate", async () => {
    const { plugin, ctx } = setup({ cache: { store: plainStore().store } });
    await expect(run(actionOf(section(plugin, "bots"), "purgeCache"), {}, await ctx())).rejects.toThrow(/cannot list/);
  });

  test("purgeUrl deletes one page's cached copies, on any store with delete", async () => {
    const custom = plainStore();
    const { plugin, get, ctx, calls } = setup({ cache: { store: custom.store } });
    await get("/posts/1?utm_source=x&b=2&a=1");
    expect(custom.map.size).toBe(1);
    const c = await ctx();
    const purge = actionOf(section(plugin, "bots"), "purgeUrl");
    expect(await run(purge, { url: `${BASE}/posts/1?a=1&b=2` }, c)).toBe(`Purged 1 cached response of ${BASE}/posts/1?a=1&b=2.`);
    expect(custom.map.size).toBe(0);
    await get("/posts/1?a=1&b=2");
    expect(calls.post).toBe(2);
    expect(await run(purge, { url: `${BASE}/posts/1?a=1&b=2` }, c)).toMatch(/Purged 1/);
    expect(await run(purge, { url: `${BASE}/posts/1?a=1&b=2` }, c)).toMatch(/Purged 0/);
    expect(validate(purge.input!, { url: "/posts/1" }).ok).toBe(false);
  });

  test("classifyUserAgent tells what a User-Agent claims and what it would get", async () => {
    const { plugin, ctx } = setup({ policy: { ai: "block" } });
    const c = await ctx();
    const classify = actionOf(section(plugin, "bots"), "classifyUserAgent");
    expect(classify.danger).toBeFalsy();
    expect(await run(classify, { userAgent: GPT["user-agent"] }, c)).toEqual({ kind: "ai", name: "GPTBot", verified: false, access: "block" });
    expect(await run(classify, { userAgent: GOOGLE["user-agent"] }, c)).toEqual({
      kind: "bot",
      name: "Googlebot",
      verified: false,
      access: "cached",
      note: "Claims to be a search engine: counted as search (access cached) only when Cloudflare or your verify hook confirms it.",
    });
    expect(await run(classify, { userAgent: BROWSER_HEADERS["user-agent"] }, c)).toEqual({ kind: "human", verified: false, access: "full", note: "A browser User-Agent: human when the request also has the headers browsers send." });
    expect(await run(classify, { userAgent: "" }, c)).toEqual({ kind: "unknown", verified: false, access: "cached" });
  });
});

/** A store with get/set/delete only (like KV or the Cache API: not enumerable). */
function plainStore() {
  const map = new Map<string, CachedResponse>();
  const store: BotCacheStore = {
    name: "custom",
    get: (k) => map.get(k),
    set: (k, e) => void map.set(k, e),
    delete: (k) => void map.delete(k),
  };
  return { map, store };
}


describe("ring()", () => {
  test("keeps the newest `capacity` items, newest first", () => {
    const r = ring<number>(3);
    expect(r.newest()).toEqual([]);
    r.push(1);
    r.push(2);
    expect(r.newest()).toEqual([2, 1]);
    r.push(3);
    expect(r.newest()).toEqual([3, 2, 1]);
    r.push(4);
    r.push(5);
    expect(r.newest()).toEqual([5, 4, 3]);
    expect(r.size).toBe(3);
  });
});

describe("bots manage() edge cases", () => {
  test("the blocked list names a country outside allowCountries", async () => {
    const { plugin, get, ctx } = setup({ allowCountries: ["VN"], trustCloudflare: true });
    await get("/posts/1", { ...BROWSER_HEADERS, "cf-ipcountry": "FR" });
    const { rows } = await listOf(section(plugin, "bots"), "blocked").list({ limit: 5 }, await ctx());
    expect(rows.map((r) => r.reason)).toEqual(["country not allowed"]);
  });

  test("purgeUrl on the memory store also removes copies varied by country", async () => {
    const { plugin, get, ctx, calls } = setup({ trustCloudflare: true, cache: { varyByCountry: true } });
    await get("/posts/1", { ...GPT, "cf-ipcountry": "VN" });
    await get("/posts/1", { ...GPT, "cf-ipcountry": "FR" });
    await get("/posts/2", GPT);
    expect(await run(actionOf(section(plugin, "bots"), "purgeUrl"), { url: `${BASE}/posts/1` }, await ctx())).toBe(`Purged 2 cached responses of ${BASE}/posts/1.`);
    await get("/posts/2", GPT);
    expect(calls.post).toBe(3);
  });

  test("purgeCache does not count entries that already expired", async () => {
    const { plugin, get, ctx, clock } = setup({ cache: { ttl: 60 } });
    await get("/posts/1");
    clock.now += 61_000;
    expect(await run(actionOf(section(plugin, "bots"), "purgeCache"), {}, await ctx())).toBe("Purged 0 cached responses.");
  });

  test("the settings form has no cacheTtl field when the cache is off", () => {
    const { plugin } = setup({ cache: false });
    expect(Object.keys((section(plugin, "bots").settings!.schema.json as { properties: object }).properties)).toEqual(["policy", "blockCountries", "allowCountries", "botScoreThreshold"]);
  });
});
