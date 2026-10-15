import { describe, expect, test } from "bun:test";
import { definePlugin, miu, route, type App, type AuthUser, type Plugin } from "miujs";
import { cache } from "../../cache/src/index.ts";
import { limiter } from "../../ratelimit/src/index.ts";
import { bots, cacheClientStore, memoryBotStore, pickFields, type BotsOptions, type Visitor } from "../src/index.ts";
import { BROWSER_HEADERS, cfRequest } from "./helpers.ts";

const BASE = "https://example.com";
const GPT = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" };
const CURL = { "user-agent": "curl/8.4.0" };
const GOOGLE = { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" };

const testAuth = definePlugin({
  name: "auth",
  onRequest(ctx) {
    if (ctx.headers.get("x-user") === "alice") ctx.user = { id: "alice", roles: [] } as AuthUser;
  },
});

function makeApp(opts: BotsOptions = {}, extra: { before?: Plugin[]; after?: Plugin[]; mcp?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const seen: Visitor[] = [];
  let version = 1;
  const hit = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);
  const clock = { now: 1_700_000_000_000 };
  const routes = [
    route.get("/posts", {
      name: "posts",
      handler: (ctx) => {
        hit("posts");
        seen.push({ ...ctx.visitor });
        return { items: [{ id: 1, title: "A", body: "long text", secret: "s" }], q: ctx.query, version };
      },
    }),
    route.get("/posts/:id", {
      name: "post",
      handler: (ctx) => {
        hit("post");
        seen.push({ ...ctx.visitor });
        return { id: ctx.params.id, title: "T", body: "long text", version };
      },
    }),
    route.post("/posts", { name: "create", handler: () => (hit("create"), { ok: true }) }),
    route.get("/cookie", { name: "cookie", handler: (ctx) => (hit("cookie"), ctx.cookies.set("a", "1"), { ok: true }) }),
    route.get("/setcookie", { name: "setcookie", handler: () => (hit("setcookie"), new Response("{}", { headers: { "set-cookie": "a=1", "content-type": "application/json" } })) }),
    route.get("/private", { name: "private", handler: (ctx) => (hit("private"), ctx.set.headers.set("cache-control", "private, max-age=60"), { ok: true }) }),
    route.get("/vary", { name: "vary", handler: (ctx) => (hit("vary"), ctx.set.headers.set("vary", "Cookie"), { ok: true }) }),
    route.get("/fail", { name: "fail", handler: () => (hit("fail"), new Response("no", { status: 500 })) }),
    route.get("/me", { name: "me", handler: (ctx) => (hit("me"), { user: ctx.user?.id ?? null }) }),
  ];
  const plugin = bots({ now: () => clock.now, ...opts, cache: opts.cache === false ? false : { store: memoryBotStore({ now: () => clock.now }), ...(opts.cache ?? {}) } });
  const app = miu({ logLevel: "silent", dev: false, mcp: extra.mcp, routes, plugins: [...(extra.before ?? [testAuth]), plugin, ...(extra.after ?? [])] });
  return { app, calls, seen, clock, plugin, bump: () => version++ };
}

async function get(app: App, path: string, headers: Record<string, string> = {}, method = "GET") {
  const res = await app.fetch(new Request(BASE + path, { method, headers }));
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body, text };
}

describe("ctx.visitor", () => {
  test("is set for every request, with location from Cloudflare", async () => {
    const { app, seen } = makeApp({ policy: { human: "full" } });
    const res = await app.dispatch(cfRequest(BASE + "/posts/1", BROWSER_HEADERS, { country: "VN", city: "Hanoi", asn: 7552 }), {}, { runtime: "workerd" });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ kind: "human", country: "VN", city: "Hanoi", asn: 7552, access: "full" });
  });
});

describe("cached access", () => {
  test("humans always reach the handler; bots get a cached copy after the first request", async () => {
    const { app, calls } = makeApp();
    for (let i = 0; i < 3; i++) expect((await get(app, "/posts/1", BROWSER_HEADERS)).headers.get("x-miu-bot-cache")).toBeNull();
    expect(calls.post).toBe(3);
    const first = await get(app, "/posts/1", GPT);
    expect(first.headers.get("x-miu-bot-cache")).toBe("miss");
    await app.drain();
    const second = await get(app, "/posts/1", CURL);
    expect(second.headers.get("x-miu-bot-cache")).toBe("hit");
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("content-type")).toContain("application/json");
    expect(calls.post).toBe(4);
  });

  test("the key ignores tracking parameters and query order, but not other parameters", async () => {
    const { app, calls } = makeApp();
    await get(app, "/posts?a=1&b=2&utm_source=x", CURL);
    await app.drain();
    expect((await get(app, "/posts?b=2&gclid=1&a=1&fbclid=z&ref=hn", CURL)).headers.get("x-miu-bot-cache")).toBe("hit");
    expect((await get(app, "/posts?a=1&b=3", CURL)).headers.get("x-miu-bot-cache")).toBe("miss");
    expect(calls.posts).toBe(2);
  });

  test("responses that are not safe to share are never stored", async () => {
    const { app, calls } = makeApp();
    for (const path of ["/cookie", "/setcookie", "/private", "/vary", "/fail"]) {
      await get(app, path, CURL);
      await app.drain();
      expect((await get(app, path, CURL)).headers.get("x-miu-bot-cache")).not.toBe("hit");
    }
    expect(calls).toMatchObject({ cookie: 2, setcookie: 2, private: 2, vary: 2, fail: 2 });
  });

  test("only GET and HEAD are cached; HEAD is answered from the GET entry without a body", async () => {
    const { app, calls } = makeApp();
    await get(app, "/posts", CURL, "POST");
    await get(app, "/posts", CURL, "POST");
    expect(calls.create).toBe(2);
    await get(app, "/posts/9", CURL);
    await app.drain();
    const head = await get(app, "/posts/9", CURL, "HEAD");
    expect(head.headers.get("x-miu-bot-cache")).toBe("hit");
    expect(head.text).toBe("");
    expect(calls.post).toBe(1);
  });

  test("concurrent misses for the same key run the handler once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const app = miu({
      logLevel: "silent",
      dev: false,
      plugins: [bots({ cache: { store: memoryBotStore() } })],
      routes: [route.get("/slow", { handler: async () => (runs++, await gate, { n: 42 }) })],
    });
    const pending = Array.from({ length: 10 }, () => get(app, "/slow", CURL));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const all = await Promise.all(pending);
    expect(runs).toBe(1);
    for (const r of all) expect(r.body).toEqual({ n: 42 });
    expect(all.filter((r) => r.headers.get("x-miu-bot-cache") === "hit").length).toBe(9);
  });

  test("a follower runs the handler itself when the leader's response cannot be stored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const app = miu({
      logLevel: "silent",
      dev: false,
      plugins: [bots({ cache: { store: memoryBotStore() } })],
      routes: [route.get("/x", { handler: async (ctx) => (runs++, await gate, ctx.set.headers.set("cache-control", "no-store"), { n: runs }) })],
    });
    const pending = [get(app, "/x", CURL), get(app, "/x", CURL)];
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all(pending);
    expect(runs).toBe(2);
  });

  describe("waitMs", () => {
    // Injected timers: tests fire them by hand and see which are still pending.
    function fakeTimers() {
      const pending = new Map<number, () => void>();
      let id = 0;
      return {
        pending,
        set: (fn: () => void, _ms: number) => (pending.set(++id, fn), id),
        clear: (h: unknown) => void pending.delete(h as number),
        fireAll: () => {
          for (const [k, fn] of [...pending]) {
            pending.delete(k);
            fn();
          }
        },
      };
    }
    const tick = () => new Promise((r) => setTimeout(r, 10));

    test("followers stop waiting for a stuck leader and run the handler; the leader still stores", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let runs = 0;
      const timers = fakeTimers();
      const app = miu({
        logLevel: "silent",
        dev: false,
        plugins: [bots({ timers, cache: { store: memoryBotStore(), waitMs: 5000 } })],
        routes: [route.get("/slow", { handler: async () => (++runs === 1 ? (await gate, { from: "leader" }) : { from: "follower" }) })],
      });
      const leader = get(app, "/slow", CURL);
      await tick();
      const followers = [get(app, "/slow", CURL), get(app, "/slow", CURL)];
      await tick();
      expect(timers.pending.size).toBe(2);
      timers.fireAll();
      const fs = await Promise.all(followers);
      for (const f of fs) {
        expect(f.status).toBe(200);
        expect(f.body).toEqual({ from: "follower" });
      }
      expect(runs).toBe(3);
      release();
      expect((await leader).body).toEqual({ from: "leader" });
      await app.drain();
      expect((await get(app, "/slow", CURL)).headers.get("x-miu-bot-cache")).toBe("hit");
      expect(runs).toBe(3);
    });

    test("the wait timer is cleared when the leader answers in time", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let runs = 0;
      const timers = fakeTimers();
      const app = miu({
        logLevel: "silent",
        dev: false,
        plugins: [bots({ timers, cache: { store: memoryBotStore() } })],
        routes: [route.get("/slow", { handler: async () => (runs++, await gate, { ok: true }) })],
      });
      const all = [get(app, "/slow", CURL), get(app, "/slow", CURL), get(app, "/slow", CURL)];
      await tick();
      expect(timers.pending.size).toBe(2);
      release();
      await Promise.all(all);
      expect(runs).toBe(1);
      expect(timers.pending.size).toBe(0);
    });

    test("waitMs must be a positive number", () => {
      expect(() => bots({ cache: { waitMs: 0 } })).toThrow(expect.objectContaining({ code: "MIU_E_BOTS_CONFIG" }));
    });
  });

  test("entries expire after ttl", async () => {
    const { app, calls, clock } = makeApp({ cache: { ttl: 60 } });
    await get(app, "/posts/1", CURL);
    await app.drain();
    clock.now += 59_000;
    expect((await get(app, "/posts/1", CURL)).headers.get("x-miu-bot-cache")).toBe("hit");
    clock.now += 2_000;
    expect((await get(app, "/posts/1", CURL)).headers.get("x-miu-bot-cache")).toBe("miss");
    expect(calls.post).toBe(2);
  });

  test("staleWhileRevalidate serves the stale copy and refreshes it once in the background", async () => {
    const { app, calls, clock, bump } = makeApp({ cache: { ttl: 60, staleWhileRevalidate: 600 } });
    await get(app, "/posts/1", CURL);
    await app.drain();
    bump();
    clock.now += 120_000;
    const stale = await Promise.all([get(app, "/posts/1", CURL), get(app, "/posts/1", CURL)]);
    for (const s of stale) {
      expect(s.headers.get("x-miu-bot-cache")).toBe("stale");
      expect(s.body.version).toBe(1);
    }
    await app.drain();
    expect(calls.post).toBe(2);
    const fresh = await get(app, "/posts/1", CURL);
    expect(fresh.headers.get("x-miu-bot-cache")).toBe("hit");
    expect(fresh.body.version).toBe(2);
  });

  test("varyByCountry keeps one entry per country", async () => {
    const { app, calls } = makeApp({ trustCloudflare: true, cache: { varyByCountry: true } });
    await get(app, "/posts/1", { ...CURL, "cf-ipcountry": "VN" });
    await app.drain();
    expect((await get(app, "/posts/1", { ...CURL, "cf-ipcountry": "US" })).headers.get("x-miu-bot-cache")).toBe("miss");
    expect((await get(app, "/posts/1", { ...CURL, "cf-ipcountry": "VN" })).headers.get("x-miu-bot-cache")).toBe("hit");
    expect(calls.post).toBe(2);
  });

  test("cache: false turns caching off (cached visitors reach the handler)", async () => {
    const { app, calls } = makeApp({ cache: false });
    await get(app, "/posts/1", CURL);
    await get(app, "/posts/1", CURL);
    expect(calls.post).toBe(2);
  });

  test("works over ctx.cache from @miujs/cache", async () => {
    let runs = 0;
    const app = miu({
      logLevel: "silent",
      dev: false,
      plugins: [cache(), bots({ cache: { store: cacheClientStore() } })],
      routes: [route.get("/x", { handler: () => (runs++, { ok: true }) })],
    });
    await get(app, "/x", CURL);
    await app.drain();
    const r = await get(app, "/x", CURL);
    expect(r.headers.get("x-miu-bot-cache")).toBe("hit");
    expect(r.body).toEqual({ ok: true });
    expect(runs).toBe(1);
  });
});

describe("signed-in users", () => {
  test("bypass the bot cache and partial responses, whatever their user agent", async () => {
    const { app, calls } = makeApp({ policy: { bot: "partial" } });
    await get(app, "/me", { ...CURL, "x-user": "alice" });
    await app.drain();
    const r = await get(app, "/me", { ...CURL, "x-user": "alice" });
    expect(r.body).toEqual({ user: "alice" });
    expect(r.headers.get("x-miu-bot-cache")).toBeNull();
    expect(calls.me).toBe(2);
    // ...and nothing a signed-in user got is served to anonymous bots.
    expect((await get(app, "/me", CURL)).body).toEqual({ user: null });
  });

  test("are not blocked by kind, but rules and country lists still apply", async () => {
    const { app } = makeApp({ trustCloudflare: true, policy: { bot: "block" }, blockCountries: ["KP"] });
    expect((await get(app, "/me", { ...CURL, "x-user": "alice" })).status).toBe(200);
    expect((await get(app, "/me", CURL)).status).toBe(403);
    expect((await get(app, "/me", { ...BROWSER_HEADERS, "x-user": "alice", "cf-ipcountry": "KP" })).status).toBe(403);
  });

  test("requests with an Authorization header are never stored", async () => {
    const { app, calls } = makeApp();
    await get(app, "/posts/1", { ...CURL, authorization: "Bearer nope" });
    await app.drain();
    expect((await get(app, "/posts/1", CURL)).headers.get("x-miu-bot-cache")).toBe("miss");
    expect(calls.post).toBe(2);
  });

  test("auth() listed after bots() fails at startup", async () => {
    const { app } = makeApp({}, { before: [], after: [testAuth] });
    expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_BOTS_ORDER" });
  });
});

describe("block", () => {
  test("blocks a kind with 403 MIU_E_BOT_BLOCKED, without running the handler", async () => {
    const { app, calls } = makeApp({ policy: { ai: "block" } });
    const r = await get(app, "/posts/1", GPT);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("MIU_E_BOT_BLOCKED");
    expect(r.body.error.fix).toBeString();
    expect(calls.post).toBeUndefined();
    expect((await get(app, "/posts/1", BROWSER_HEADERS)).status).toBe(200);
  });

  test("the block status is configurable", async () => {
    const { app } = makeApp({ policy: { bot: "block" }, blockStatus: 404 });
    expect((await get(app, "/posts", CURL)).status).toBe(404);
    const t = makeApp({ policy: { bot: "block" }, blockStatus: 429 });
    const r = await get(t.app, "/posts", CURL);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("3600");
  });

  test("rules run first, in order", async () => {
    const { app } = makeApp({
      trustCloudflare: true,
      policy: { human: "full" },
      rules: [
        { when: (v) => v.country === "RU", action: "block" },
        { when: (v, ctx) => v.kind === "ai" && ctx.path.startsWith("/posts/"), action: "full" },
      ],
    });
    expect((await get(app, "/posts/1", { ...BROWSER_HEADERS, "cf-ipcountry": "RU" })).status).toBe(403);
    const ai = await get(app, "/posts/1", GPT);
    expect(ai.headers.get("x-miu-bot-cache")).toBeNull();
  });

  test("blockCountries and allowCountries", async () => {
    const block = makeApp({ trustCloudflare: true, blockCountries: ["KP"] });
    expect((await get(block.app, "/posts", { ...BROWSER_HEADERS, "cf-ipcountry": "KP" })).status).toBe(403);
    expect((await get(block.app, "/posts", { ...BROWSER_HEADERS, "cf-ipcountry": "VN" })).status).toBe(200);
    const allow = makeApp({ trustCloudflare: true, allowCountries: ["VN", "US"] });
    expect((await get(allow.app, "/posts", { ...BROWSER_HEADERS, "cf-ipcountry": "DE" })).status).toBe(403);
    expect((await get(allow.app, "/posts", { ...BROWSER_HEADERS, "cf-ipcountry": "VN" })).status).toBe(200);
    // Unknown country is not blocked by an allow list (no Cloudflare, local dev, IPv6 gaps).
    expect((await get(allow.app, "/posts", BROWSER_HEADERS)).status).toBe(200);
  });

  test("never blocks the MCP endpoint, /_miu/* or robots.txt", async () => {
    const { app } = makeApp({ policy: { unknown: "block", bot: "block" }, robots: true }, { mcp: true });
    const mcp = await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    expect(mcp.status).not.toBe(403);
    await mcp.body?.cancel();
    expect((await get(app, "/robots.txt", CURL)).status).toBe(200);
    expect((await get(app, "/posts", CURL)).status).toBe(403);
  });
});

describe("per-route rules", () => {
  test("a route can change the policy or be exempt", async () => {
    const { app, calls } = makeApp({
      routes: [
        { match: { route: "post" }, policy: { ai: "block" } },
        { match: { path: "/posts" }, exempt: true },
      ],
    });
    expect((await get(app, "/posts/1", GPT)).status).toBe(403);
    await get(app, "/posts", GPT);
    await app.drain();
    expect((await get(app, "/posts", GPT)).headers.get("x-miu-bot-cache")).toBeNull();
    expect(calls.posts).toBe(2);
  });

  test("route ttl overrides the plugin ttl", async () => {
    const { app, clock } = makeApp({ cache: { ttl: 3600 }, routes: [{ match: { route: "post" }, ttl: 10 }] });
    await get(app, "/posts/1", CURL);
    await app.drain();
    clock.now += 11_000;
    expect((await get(app, "/posts/1", CURL)).headers.get("x-miu-bot-cache")).toBe("miss");
  });
});

describe("partial access", () => {
  test("the handler sees access 'partial' and the JSON body is trimmed to the route's fields", async () => {
    const { app, seen } = makeApp({
      policy: { bot: "partial" },
      // "/posts/*" also matches "/posts" itself, so the more specific rule comes first.
      routes: [{ match: { route: "posts" }, partial: (data: any) => ({ items: data.items.map((p: any) => pickFields(p, ["id", "title"])) }) }, { match: { path: "/posts/*" }, partial: ["id", "title"] }],
    });
    const one = await get(app, "/posts/7", CURL);
    expect(one.body).toEqual({ id: "7", title: "T" });
    expect(seen[0].access).toBe("partial");
    const list = await get(app, "/posts", CURL);
    expect(list.body).toEqual({ items: [{ id: 1, title: "A" }] });
    // Humans get everything.
    expect((await get(app, "/posts/7", BROWSER_HEADERS)).body).toMatchObject({ body: "long text" });
  });

  test("partial responses are cached separately from cached-access ones", async () => {
    const { app, calls } = makeApp({ policy: { bot: "partial", ai: "cached" }, routes: [{ match: { path: "/posts/*" }, partial: ["id"] }] });
    await get(app, "/posts/1", CURL);
    await app.drain();
    const bot = await get(app, "/posts/1", CURL);
    expect(bot.headers.get("x-miu-bot-cache")).toBe("hit");
    expect(bot.body).toEqual({ id: "1" });
    const ai = await get(app, "/posts/1", GPT);
    expect(ai.headers.get("x-miu-bot-cache")).toBe("miss");
    expect(ai.body).toMatchObject({ body: "long text" });
    expect(calls.post).toBe(2);
  });

  test("pickFields picks from objects and arrays of objects", () => {
    expect(pickFields({ a: 1, b: 2 }, ["a", "z"])).toEqual({ a: 1 });
    expect(pickFields([{ a: 1, b: 2 }, { a: 3 }], ["a"])).toEqual([{ a: 1 }, { a: 3 }]);
    expect(pickFields("x", ["a"])).toBe("x");
  });
});

describe("verification", () => {
  test("a verify hook upgrades a search engine claim to verified search", async () => {
    const { app, calls } = makeApp({ policy: { search: "full" }, verify: (req, claim) => claim.name === "Googlebot" && req.headers.get("x-test-rdns") === "ok" });
    await get(app, "/posts/1", { ...GOOGLE, "x-test-rdns": "ok" });
    await get(app, "/posts/1", { ...GOOGLE, "x-test-rdns": "ok" });
    expect(calls.post).toBe(2);
    // Without verification the claim is a plain bot (cached).
    await get(app, "/posts/2", GOOGLE);
    await app.drain();
    expect((await get(app, "/posts/2", GOOGLE)).headers.get("x-miu-bot-cache")).toBe("hit");
  });
});

describe("robots.txt and X-Robots-Tag", () => {
  test("disallowAI lists AI crawlers, including robots-only tokens, and leaves search engines alone", async () => {
    const { app } = makeApp({ robots: { disallowAI: true, disallow: ["/admin"], sitemap: "https://example.com/sitemap.xml" } });
    const r = await get(app, "/robots.txt", BROWSER_HEADERS);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(r.text).toContain("User-agent: GPTBot\n");
    expect(r.text).toContain("User-agent: Google-Extended\n");
    expect(r.text).not.toContain("Googlebot");
    expect(r.text).toMatch(/User-agent: \*\nDisallow: \/admin\n/);
    expect(r.text).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  test("xRobotsTag is added to responses", async () => {
    const { app } = makeApp({ xRobotsTag: "noai, noimageai" });
    expect((await get(app, "/posts/1", BROWSER_HEADERS)).headers.get("x-robots-tag")).toBe("noai, noimageai");
  });
});

describe("budget", () => {
  test("a per-kind limiter caps requests that reach the handler; cache hits are free", async () => {
    const { app } = makeApp({ budget: { bot: limiter({ limit: 2, window: "1m", name: "bots" }) } });
    expect((await get(app, "/posts/1", CURL)).status).toBe(200);
    await app.drain();
    for (let i = 0; i < 5; i++) expect((await get(app, "/posts/1", CURL)).status).toBe(200);
    expect((await get(app, "/posts/2", CURL)).status).toBe(200);
    const r = await get(app, "/posts/3", CURL);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("MIU_E_RATE_LIMITED");
  });
});

describe("options and inspect", () => {
  test("invalid options fail fast with MIU_E_BOTS_CONFIG", () => {
    expect(() => bots({ policy: { ai: "nope" as never } })).toThrow(expect.objectContaining({ code: "MIU_E_BOTS_CONFIG" }));
    expect(() => bots({ policy: { robot: "block" } as never })).toThrow(expect.objectContaining({ code: "MIU_E_BOTS_CONFIG" }));
    expect(() => bots({ blockCountries: ["Vietnam"] })).toThrow(expect.objectContaining({ code: "MIU_E_BOTS_CONFIG" }));
    expect(() => bots({ rules: [{ action: "block" } as never] })).toThrow(expect.objectContaining({ code: "MIU_E_BOTS_CONFIG" }));
    expect(() => bots({ cache: { ttl: 0 } })).toThrow(expect.objectContaining({ code: "MIU_E_BOTS_CONFIG" }));
    expect(() => bots({ blockStatus: 200 as never })).toThrow(expect.objectContaining({ code: "MIU_E_BOTS_CONFIG" }));
  });

  test("inspect shows the policy and counters", async () => {
    const { app, plugin } = makeApp({ policy: { ai: "block" } });
    await get(app, "/posts/1", GPT);
    await get(app, "/posts/1", BROWSER_HEADERS);
    await get(app, "/posts/1", CURL);
    await app.drain();
    await get(app, "/posts/1", CURL);
    const info = plugin.inspect() as any;
    expect(info.policy).toMatchObject({ human: "full", ai: "block", bot: "cached", search: "cached", unknown: "cached" });
    expect(info.counters.kinds).toMatchObject({ ai: 1, human: 1, bot: 2 });
    expect(info.counters.actions).toMatchObject({ block: 1, full: 1, cached: 2 });
    expect(info.counters.cache).toMatchObject({ hit: 1, miss: 1, stored: 1 });
    expect(info.cache.store).toBe("memory");
    expect(plugin.cloudflare()).toEqual({});
  });
});

describe("the bots route option", () => {
  function app(extra: Partial<BotsOptions> = {}) {
    let runs = 0;
    const a = miu({
      logLevel: "silent",
      dev: false,
      plugins: [bots({ cache: { store: memoryBotStore() }, ...extra })],
      routes: [
        route.get("/members", { bots: { policy: { ai: "block", bot: "block" } }, handler: () => (runs++, { ok: true }) }),
        route.get("/live", { bots: false, handler: () => (runs++, { ok: true }) }),
        route.get("/card/:id", { bots: { policy: { bot: "partial" }, partial: ["id", "title"] }, handler: (ctx) => (runs++, { id: ctx.params.id, title: "T", body: "b" }) }),
        route.get("/plain", { handler: () => (runs++, { ok: true }) }),
      ],
    });
    return { a, runs: () => runs };
  }

  test("sets the policy for one route", async () => {
    const { a } = app();
    expect((await get(a, "/members", GPT)).status).toBe(403);
    expect((await get(a, "/plain", GPT)).status).toBe(200);
  });

  test("false exempts the route: every visitor reaches the handler", async () => {
    const { a, runs } = app();
    await get(a, "/live", CURL);
    await a.drain();
    expect((await get(a, "/live", CURL)).headers.get("x-miu-bot-cache")).toBeNull();
    expect(runs()).toBe(2);
  });

  test("partial fields come from the route", async () => {
    const { a } = app();
    expect((await get(a, "/card/3", CURL)).body).toEqual({ id: "3", title: "T" });
  });

  test("wins over a matching routes[] entry", async () => {
    const { a } = app({ routes: [{ match: { path: "/members" }, exempt: true }, { match: { path: "/live" }, policy: { bot: "block" } }] });
    expect((await get(a, "/members", CURL)).status).toBe(403);
    expect((await get(a, "/live", CURL)).status).toBe(200);
  });

  test("an invalid route option fails with MIU_E_BOTS_CONFIG", async () => {
    const a = miu({ logLevel: "silent", dev: false, plugins: [bots()], routes: [route.get("/x", { bots: { policy: { ai: "nope" as never } }, handler: () => "x" })] });
    const r = await get(a, "/x", GPT);
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("MIU_E_BOTS_CONFIG");
  });
});
