import { describe, expect, test } from "bun:test";
import { definePlugin, isMiuError, miu, route, t, type AuthUser, type Plugin } from "miujs";
import { asAuthLimiter, limiter, memoryStore, rateLimit, redisStore, type RateLimitOptions, type RateLimitStore } from "../src/index.ts";
import { fakeRedis } from "./fakes.ts";

const BASE = "http://localhost";
const S = 1000;
const M = 60 * S;
const T0 = 1_000 * M;

const USERS: Record<string, AuthUser> = { alice: { id: "alice", roles: [] }, bob: { id: "bob", roles: [] } };
const testAuth = definePlugin({
  name: "test-auth",
  onRequest(ctx) {
    const id = ctx.headers.get("x-user");
    if (id && Object.prototype.hasOwnProperty.call(USERS, id)) ctx.user = USERS[id];
  },
});

const routes = [
  route.post("/auth/login", { name: "auth_login", handler: () => ({ ok: true }) }),
  route.get("/api/items", { name: "items", tags: ["public"], handler: () => ({ items: [] }) }),
  route.get("/api/items/:id", { name: "item", params: t.object({ id: t.string() }), handler: (c) => ({ id: c.params.id }) }),
  route.post("/api/items", { name: "create_item", handler: () => ({ ok: true }) }),
  route.get("/apix", { name: "apix", handler: () => "x" }),
  route.get("/other", { name: "other", tags: ["game"], handler: () => "o" }),
];

function makeApp(opts: Partial<RateLimitOptions> & Pick<RateLimitOptions, "rules">, plugins: Plugin[] = [testAuth]) {
  const clock = { now: T0 };
  const app = miu({ logLevel: "silent", plugins: [...plugins, rateLimit({ now: () => clock.now, ...opts })], routes });
  return { app, clock };
}

/** Sends from `ip` (Workers runtime reads cf-connecting-ip, which Cloudflare sets). */
function send(app: any, method: string, path: string, opts: { ip?: string; headers?: Record<string, string>; env?: Record<string, unknown> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  return app.dispatch(new Request(BASE + path, { method, headers }), opts.env ?? {}, { runtime: "workerd" }) as Promise<Response>;
}

async function statuses(app: any, n: number, method: string, path: string, opts: Parameters<typeof send>[3] = {}) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send(app, method, path, opts)).status);
  return out;
}

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return isMiuError(e) ? e.code : String(e);
  }
  return undefined;
}

describe("matching", () => {
  test("by route name", async () => {
    const { app } = makeApp({ rules: [{ match: { route: "auth_login" }, limit: 2, window: "15m" }] });
    expect(await statuses(app, 3, "POST", "/auth/login", { ip: "1.1.1.1" })).toEqual([200, 200, 429]);
    expect(await statuses(app, 3, "GET", "/api/items", { ip: "1.1.1.1" })).toEqual([200, 200, 200]);
  });

  test("by path pattern: /api/* covers everything below /api, not /apix", async () => {
    const { app } = makeApp({ rules: [{ match: { path: "/api/*" }, limit: 2, window: "1m" }] });
    expect(await statuses(app, 2, "GET", "/api/items", { ip: "1.1.1.1" })).toEqual([200, 200]);
    expect((await send(app, "GET", "/api/items/7", { ip: "1.1.1.1" })).status).toBe(429);
    expect(await statuses(app, 3, "GET", "/apix", { ip: "1.1.1.1" })).toEqual([200, 200, 200]);
  });

  test("path params match one segment", async () => {
    const { app } = makeApp({ rules: [{ match: { path: "/api/items/:id" }, limit: 1, window: "1m" }] });
    expect(await statuses(app, 2, "GET", "/api/items/1", { ip: "1.1.1.1" })).toEqual([200, 429]);
    expect(await statuses(app, 2, "GET", "/api/items", { ip: "1.1.1.1" })).toEqual([200, 200]);
  });

  test("by method and tag; criteria combine with AND, lists with OR", async () => {
    const { app } = makeApp({
      rules: [
        { name: "writes", match: { path: "/api/*", method: ["POST", "PUT"] }, limit: 1, window: "1m" },
        { name: "tagged", match: { tag: ["game", "nope"] }, limit: 1, window: "1m" },
      ],
    });
    expect(await statuses(app, 2, "POST", "/api/items", { ip: "1.1.1.1" })).toEqual([200, 429]);
    expect(await statuses(app, 2, "GET", "/api/items", { ip: "1.1.1.1" })).toEqual([200, 200]);
    expect(await statuses(app, 2, "GET", "/other", { ip: "1.1.1.1" })).toEqual([200, 429]);
  });

  test("a rule without match applies to every request, 404s included (scanners)", async () => {
    const { app } = makeApp({ rules: [{ limit: 2, window: "1m" }] });
    expect(await statuses(app, 3, "GET", "/does-not-exist", { ip: "1.1.1.1" })).toEqual([404, 404, 429]);
  });

  test("method matching is case-insensitive in config", async () => {
    const { app } = makeApp({ rules: [{ match: { method: "post" }, limit: 1, window: "1m" }] });
    expect(await statuses(app, 2, "POST", "/auth/login", { ip: "1.1.1.1" })).toEqual([200, 429]);
  });
});

describe("429 and headers", () => {
  test("429 is MIU_E_RATE_LIMITED with Retry-After and a fix", async () => {
    const { app } = makeApp({ rules: [{ name: "login", match: { route: "auth_login" }, limit: 1, window: "1m", algorithm: "fixed" }] });
    await send(app, "POST", "/auth/login", { ip: "1.1.1.1" });
    const res = await send(app, "POST", "/auth/login", { ip: "1.1.1.1" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_RATE_LIMITED");
    expect(body.error.fix).toContain("60");
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
  });

  test("IETF draft headers on allowed responses (default)", async () => {
    const { app } = makeApp({ rules: [{ limit: 5, window: "1m", algorithm: "fixed" }] });
    const res = await send(app, "GET", "/api/items", { ip: "1.1.1.1" });
    expect(res.headers.get("ratelimit-limit")).toBe("5");
    expect(res.headers.get("ratelimit-remaining")).toBe("4");
    expect(res.headers.get("ratelimit-reset")).toBe("60");
    expect(res.headers.get("retry-after")).toBeNull();
  });

  test('combined RateLimit + RateLimit-Policy with headers: "draft-8"', async () => {
    const { app } = makeApp({ headers: "draft-8", rules: [{ name: "api", limit: 5, window: "1m", algorithm: "fixed" }] });
    const res = await send(app, "GET", "/api/items", { ip: "1.1.1.1" });
    expect(res.headers.get("ratelimit-policy")).toBe('"api";q=5;w=60');
    expect(res.headers.get("ratelimit")).toBe('"api";r=4;t=60');
    expect(res.headers.get("ratelimit-limit")).toBeNull();
  });

  test("headers: false sends none (but still Retry-After on 429)", async () => {
    const { app } = makeApp({ headers: false, rules: [{ limit: 1, window: "1m" }] });
    const ok = await send(app, "GET", "/api/items", { ip: "1.1.1.1" });
    expect([...ok.headers.keys()].some((k) => k.startsWith("ratelimit"))).toBe(false);
    const no = await send(app, "GET", "/api/items", { ip: "1.1.1.1" });
    expect(no.headers.get("retry-after")).toBeTruthy();
  });

  test("with several rules, the strictest one is reported and any denial blocks", async () => {
    const { app } = makeApp({
      rules: [
        { name: "global", limit: 100, window: "1m", algorithm: "fixed" },
        { name: "items", match: { route: "items" }, limit: 2, window: "1m", algorithm: "fixed" },
      ],
    });
    const r1 = await send(app, "GET", "/api/items", { ip: "1.1.1.1" });
    expect(r1.headers.get("ratelimit-limit")).toBe("2");
    expect(r1.headers.get("ratelimit-remaining")).toBe("1");
    await send(app, "GET", "/api/items", { ip: "1.1.1.1" });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(429);
    expect((await send(app, "GET", "/other", { ip: "1.1.1.1" })).headers.get("ratelimit-limit")).toBe("100");
  });

  test("the window passes on the injected clock", async () => {
    const { app, clock } = makeApp({ rules: [{ limit: 1, window: "1m", algorithm: "fixed" }] });
    expect(await statuses(app, 2, "GET", "/api/items", { ip: "1.1.1.1" })).toEqual([200, 429]);
    clock.now += M;
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(200);
  });
});

describe("identity (by)", () => {
  test("ip: separate buckets per client", async () => {
    const { app } = makeApp({ rules: [{ limit: 1, window: "1m" }] });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "2.2.2.2" })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(429);
  });

  test("ip: X-Forwarded-For is ignored unless trusted (no spoofing your way out)", async () => {
    const { app } = makeApp({ rules: [{ limit: 1, window: "1m" }] });
    await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { "x-forwarded-for": "9.9.9.1" } });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { "x-forwarded-for": "9.9.9.2" } })).status).toBe(429);
  });

  test("trustProxyHeader: uses the rightmost (proxy-appended) address", async () => {
    const { app } = makeApp({ trustProxyHeader: "x-forwarded-for", rules: [{ limit: 1, window: "1m" }] });
    expect((await send(app, "GET", "/api/items", { headers: { "x-forwarded-for": "6.6.6.6, 3.3.3.3" } })).status).toBe(200);
    // The client forged the left part; the proxy-added right part is the same client: still limited.
    expect((await send(app, "GET", "/api/items", { headers: { "x-forwarded-for": "7.7.7.7, 3.3.3.3" } })).status).toBe(429);
    expect((await send(app, "GET", "/api/items", { headers: { "x-forwarded-for": "4.4.4.4" } })).status).toBe(200);
  });

  test("an unknown IP shares one bucket (fails closed, not open)", async () => {
    const { app } = makeApp({ rules: [{ limit: 1, window: "1m" }] });
    expect((await app.fetch(new Request(`${BASE}/api/items`))).status).toBe(200);
    expect((await app.fetch(new Request(`${BASE}/api/items`))).status).toBe(429);
  });

  test("user: per signed-in user, anonymous falls back to IP", async () => {
    const { app } = makeApp({ rules: [{ limit: 1, window: "1m", by: "user" }] });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { "x-user": "alice" } })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { "x-user": "bob" } })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "2.2.2.2", headers: { "x-user": "alice" } })).status).toBe(429);
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(429);
  });

  test("user: a user id cannot collide with an IP bucket", async () => {
    const { app } = makeApp({ rules: [{ limit: 1, window: "1m", by: "user" }] });
    // A user whose id looks like an IP bucket key must not share (or exhaust) that bucket.
    for (const id of ["1.1.1.1", "ip:1.1.1.1"]) USERS[id] = { id, roles: [] };
    try {
      expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(200);
      expect((await send(app, "GET", "/api/items", { ip: "5.5.5.5", headers: { "x-user": "1.1.1.1" } })).status).toBe(200);
      expect((await send(app, "GET", "/api/items", { ip: "5.5.5.5", headers: { "x-user": "ip:1.1.1.1" } })).status).toBe(200);
    } finally {
      for (const id of ["1.1.1.1", "ip:1.1.1.1"]) delete USERS[id];
    }
  });

  test("apiKey: per key (x-api-key or Bearer), never stored raw; none falls back to IP", async () => {
    const seen: string[] = [];
    const inner = memoryStore();
    const spy: RateLimitStore = { ...inner, kind: "spy", consume: (k, p, n, e) => (seen.push(k), inner.consume(k, p, n, e)) };
    const { app } = makeApp({ store: spy, rules: [{ limit: 1, window: "1m", by: "apiKey" }] });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { "x-api-key": "sk_live_SECRET1" } })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { authorization: "Bearer sk_live_SECRET2" } })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "2.2.2.2", headers: { "x-api-key": "sk_live_SECRET1" } })).status).toBe(429);
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(200);
    expect(seen.join(" ")).not.toContain("SECRET");
  });

  test("a function; returning null exempts the request from that rule", async () => {
    const { app } = makeApp({ rules: [{ limit: 1, window: "1m", by: (ctx) => (ctx.headers.get("x-internal") ? null : (ctx.headers.get("x-tenant") ?? "none")) }] });
    expect((await send(app, "GET", "/api/items", { headers: { "x-tenant": "t1" } })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { headers: { "x-tenant": "t2" } })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { headers: { "x-tenant": "t1" } })).status).toBe(429);
    expect(await statuses(app, 3, "GET", "/api/items", { headers: { "x-internal": "1", "x-tenant": "t1" } })).toEqual([200, 200, 200]);
  });

  test("keyBy sets the default identity", async () => {
    const { app } = makeApp({ keyBy: "user", rules: [{ limit: 1, window: "1m" }] });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { "x-user": "alice" } })).status).toBe(200);
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1", headers: { "x-user": "bob" } })).status).toBe(200);
  });

  test("rules count separately even for the same client", async () => {
    const { app } = makeApp({
      rules: [
        { name: "a", match: { route: "items" }, limit: 1, window: "1m" },
        { name: "b", match: { route: "other" }, limit: 1, window: "1m" },
      ],
    });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(200);
    expect((await send(app, "GET", "/other", { ip: "1.1.1.1" })).status).toBe(200);
  });
});

describe("configuration errors (with a fix)", () => {
  const bad: [string, () => unknown, string][] = [
    ["no rules", () => rateLimit({ rules: [] }), "MIU_E_RATELIMIT_CONFIG"],
    ["bad window", () => rateLimit({ rules: [{ limit: 1, window: "soon" }] }), "MIU_E_RATELIMIT_CONFIG"],
    ["bad limit", () => rateLimit({ rules: [{ limit: 0, window: "1m" }] }), "MIU_E_RATELIMIT_CONFIG"],
    ["unknown by", () => rateLimit({ rules: [{ limit: 1, window: "1m", by: "email" as any }] }), "MIU_E_RATELIMIT_CONFIG"],
    ["unknown match key", () => rateLimit({ rules: [{ limit: 1, window: "1m", match: { route: "x", host: "y" } as any }] }), "MIU_E_RATELIMIT_CONFIG"],
    ["bad path", () => rateLimit({ rules: [{ limit: 1, window: "1m", match: { path: "api/*" } }] }), "MIU_E_RATELIMIT_CONFIG"],
    ["duplicate names", () => rateLimit({ rules: [{ name: "a", limit: 1, window: "1m" }, { name: "a", limit: 2, window: "1m" }] }), "MIU_E_RATELIMIT_CONFIG"],
    ["bad name", () => rateLimit({ rules: [{ name: "a:b", limit: 1, window: "1m" }] }), "MIU_E_RATELIMIT_CONFIG"],
    ["store cannot run it", () => rateLimit({ store: redisStore(fakeRedis(Date.now)), rules: [{ limit: 1, window: "1m", algorithm: "token-bucket" }] }), "MIU_E_RATELIMIT_UNSUPPORTED"],
  ];
  for (const [name, fn, code] of bad) {
    test(name, async () => {
      let err: any;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(isMiuError(err) && err.code).toBe(code);
      expect(err.fix).toBeTruthy();
    });
  }

  test('by: "user" with the auth plugin listed after rateLimit is caught at startup', async () => {
    const lateAuth = definePlugin({ name: "auth" });
    const app = miu({ logLevel: "silent", plugins: [rateLimit({ rules: [{ limit: 1, window: "1m", by: "user" }] }), lateAuth], routes });
    expect(await codeOf(() => app.ready())).toBe("MIU_E_RATELIMIT_ORDER");
  });
});

describe("store failures", () => {
  const broken: RateLimitStore = { kind: "broken", consume: async () => { throw new Error("redis down"); } };

  test("fail closed by default: 503 MIU_E_RATELIMIT_STORE", async () => {
    const { app } = makeApp({ store: broken, rules: [{ limit: 1, window: "1m" }] });
    const res = await send(app, "GET", "/api/items", { ip: "1.1.1.1" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("MIU_E_RATELIMIT_STORE");
  });

  test('onStoreError: "allow" lets requests through', async () => {
    const { app } = makeApp({ store: broken, onStoreError: "allow", rules: [{ limit: 1, window: "1m" }] });
    expect((await send(app, "GET", "/api/items", { ip: "1.1.1.1" })).status).toBe(200);
  });
});

describe("inspect and cloudflare", () => {
  test("describes rules without leaking functions", () => {
    const p = rateLimit({ rules: [{ name: "login", match: { route: "auth_login" }, limit: 10, window: "15m", by: "ip" }, { limit: 5, window: 30, by: () => "x" }] });
    expect(p.inspect!()).toEqual({
      store: { store: "memory", exact: "per process", keys: 0, maxKeys: 100000 },
      headers: "draft-6",
      ipFrom: "ctx.ip",
      onStoreError: "deny",
      rules: [
        { name: "login", match: { route: ["auth_login"] }, limit: 10, window: "15m", windowSeconds: 900, algorithm: "sliding", by: "ip" },
        { name: "rule_2", match: "all requests", limit: 5, window: 30, windowSeconds: 30, algorithm: "sliding", by: "custom" },
      ],
    });
  });

  test("cloudflare() comes from the store", () => {
    const store: RateLimitStore = { ...memoryStore(), kind: "x", cloudflare: () => ({ kv: ["RL"] }) };
    expect(rateLimit({ store, rules: [{ limit: 1, window: "1m" }] }).cloudflare!()).toEqual({ kv: ["RL"] });
  });
});

describe("limiter() outside routes", () => {
  test("check(key) for WebSocket messages, with a token bucket", async () => {
    const clock = { now: T0 };
    const l = limiter({ limit: 10, window: "1s", algorithm: "token-bucket", burst: 3, now: () => clock.now });
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await l.check("player:1"));
    expect(r.map((x) => x.allowed)).toEqual([true, true, true, false]);
    expect(r[3].retryAfter).toBe(1); // seconds, rounded up
    clock.now += 100; // 10/s → one token per 100 ms
    expect((await l.check("player:1")).allowed).toBe(true);
    expect((await l.check("player:2")).allowed).toBe(true);
  });

  test("cost and reset", async () => {
    const l = limiter({ limit: 5, window: "1m", algorithm: "fixed", now: () => T0 });
    expect((await l.check("k", { cost: 5 })).remaining).toBe(0);
    expect((await l.check("k")).allowed).toBe(false);
    await l.reset("k");
    expect((await l.check("k")).allowed).toBe(true);
  });

  test("validates config like rules do", () => {
    expect(() => limiter({ limit: 1, window: "1x" })).toThrow();
    expect(() => limiter({ limit: 1, window: "1m", store: redisStore(fakeRedis(Date.now)), algorithm: "token-bucket" })).toThrow(/token/);
  });

  test("redis reset goes through the limiter's policy", async () => {
    const clock = { now: T0 };
    const l = limiter({ limit: 1, window: "1m", algorithm: "fixed", store: redisStore(fakeRedis(() => clock.now)), now: () => clock.now });
    await l.check("k");
    expect((await l.check("k")).allowed).toBe(false);
    await l.reset("k");
    expect((await l.check("k")).allowed).toBe(true);
  });
});

describe("asAuthLimiter", () => {
  test("implements auth's RateLimiter: hit(key, limit, windowSeconds, env)", async () => {
    const clock = { now: T0 };
    const l = asAuthLimiter(memoryStore(), { now: () => clock.now });
    expect(l.kind).toBe("ratelimit:memory");
    expect(await l.hit("login:a", 2, 60)).toEqual({ ok: true, retryAfter: 60 });
    expect(await l.hit("login:a", 2, 60)).toMatchObject({ ok: true });
    expect(await l.hit("login:a", 2, 60)).toEqual({ ok: false, retryAfter: 60 });
    clock.now += 30 * S;
    expect(await l.hit("login:a", 2, 60)).toEqual({ ok: false, retryAfter: 30 });
    clock.now += 30 * S;
    expect((await l.hit("login:a", 2, 60)).ok).toBe(true);
  });

  test("plugs into @miujs/auth", async () => {
    const { auth, memoryUserStore } = await import("../../auth/src/index.ts");
    const { session } = await import("../../session/src/index.ts");
    const { SECRET } = await import("../../session/test/helpers.ts");
    const app = miu({
      logLevel: "silent",
      plugins: [
        session({ secret: SECRET }),
        auth({ users: memoryUserStore(), password: { algorithm: "pbkdf2", iterations: 1000 }, rateLimit: { limiter: asAuthLimiter(memoryStore()), login: { perAccount: 2 } } }),
      ],
    });
    const login = () =>
      app.fetch(new Request(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@example.com", password: "wrong password!!" }) }));
    expect([(await login()).status, (await login()).status, (await login()).status]).toEqual([401, 401, 429]);
  });
});
