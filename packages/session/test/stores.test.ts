import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { d1, sqlite } from "../../db/src/index.ts";
import { fakeRedis } from "../../cache/test/fake-redis.ts";
import { dbSessionStore, kvSessionStore, memorySessionStore, redisSessionStore, session, type KVLike, type SessionStore } from "../src/index.ts";
import { Jar, SECRET } from "./helpers.ts";

const BASE = "http://localhost";

/** Minimal in-memory stand-in for a Cloudflare KV namespace binding (Cloudflare's API, not ours). */
function fakeKV() {
  const map = new Map<string, { value: string; ttl?: number }>();
  const kv: KVLike & { map: typeof map } = {
    map,
    async get(key) {
      const v = map.get(key);
      return v ? JSON.parse(v.value) : null;
    },
    async put(key, value, opts) {
      map.set(key, { value, ttl: opts?.expirationTtl });
    },
    async delete(key) {
      map.delete(key);
    },
  };
  return kv;
}

function appWith(store: SessionStore, maxAge?: number) {
  return miu({
    logLevel: "silent",
    plugins: [session({ secret: SECRET, store, maxAge })],
    routes: [
      route.post("/set", { handler: (c) => void c.session.set("n", ((c.session.get<number>("n") ?? 0) + 1)) }),
      route.get("/get", { handler: (c) => ({ n: c.session.get("n") ?? null, id: c.session.id }) }),
      route.post("/regen", { handler: (c) => void c.session.regenerate() }),
      route.post("/destroy", { handler: (c) => void c.session.destroy() }),
    ],
  });
}

const env = (extra: Record<string, unknown> = {}) => ({ SESSION_SECRET: SECRET, ...extra });

async function behavesLikeAServerStore(make: () => { store: SessionStore; count(): Promise<number>; env?: Record<string, unknown> }) {
  const { store, count, env: e = {} } = make();
  const app = appWith(store);
  const send = (req: Request) => app.dispatch(req, env(e), { runtime: "bun" });
  const jar = new Jar();

  jar.store(await send(jar.request(`${BASE}/set`, { method: "POST" })));
  jar.store(await send(jar.request(`${BASE}/set`, { method: "POST" })));
  const got = await (await send(jar.request(`${BASE}/get`))).json();
  expect(got.n).toBe(2);
  // The cookie holds only the signed id.
  const raw = decodeURIComponent(jar.cookies.get("miu_session")!);
  expect(raw.split(".")[0]).toBe(got.id);
  expect(await count()).toBe(1);

  // A forged id (valid format, bad signature) is ignored.
  const forged = new Jar();
  forged.cookies.set("miu_session", `${got.id}.${"A".repeat(43)}`);
  expect((await (await send(forged.request(`${BASE}/get`))).json()).n).toBeNull();

  // regenerate() moves the data to a new id and deletes the old record.
  jar.store(await send(jar.request(`${BASE}/regen`, { method: "POST" })));
  const after = await (await send(jar.request(`${BASE}/get`))).json();
  expect(after.n).toBe(2);
  expect(after.id).not.toBe(got.id);
  expect(await count()).toBe(1);
  const old = new Jar();
  old.cookies.set("miu_session", encodeURIComponent(raw));
  expect((await (await send(old.request(`${BASE}/get`))).json()).n).toBeNull();

  // destroy() deletes the record.
  jar.store(await send(jar.request(`${BASE}/destroy`, { method: "POST" })));
  expect(await count()).toBe(0);
}

describe("server-side stores", () => {
  test("memorySessionStore", async () => {
    await behavesLikeAServerStore(() => {
      const store = memorySessionStore();
      return { store, count: async () => store.size };
    });
  });

  test("kvSessionStore(binding name) reads env per request, with a TTL", async () => {
    const kv = fakeKV();
    await behavesLikeAServerStore(() => ({ store: kvSessionStore("SESSIONS"), count: async () => kv.map.size, env: { SESSIONS: kv } }));
    const app = appWith(kvSessionStore(kv), 3600);
    await app.dispatch(new Request(`${BASE}/set`, { method: "POST" }), env(), { runtime: "bun" });
    expect([...kv.map.values()][0].ttl).toBe(3600);
  });

  test("kvSessionStore with a missing binding fails with a fix", async () => {
    const app = appWith(kvSessionStore("SESSIONS"));
    const res = await app.dispatch(new Request(`${BASE}/set`, { method: "POST" }), env(), { runtime: "bun" });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_SESSION_KV_MISSING");
  });

  test("dbSessionStore with @miujs/db sqlite", async () => {
    const database = sqlite();
    await behavesLikeAServerStore(() => ({
      store: dbSessionStore(database),
      count: async () => (await database.prepare("SELECT count(*) AS n FROM miu_sessions").first<number>("n")) ?? 0,
    }));
  });

  test("dbSessionStore with a d1 binding name", async () => {
    const database = sqlite();
    await behavesLikeAServerStore(() => ({
      store: dbSessionStore(d1("DB")),
      count: async () => (await database.prepare("SELECT count(*) AS n FROM miu_sessions").first<number>("n")) ?? 0,
      env: { DB: database },
    }));
  });

  test("expired server sessions are rejected", async () => {
    const store = memorySessionStore();
    const app = appWith(store, 1);
    const jar = new Jar();
    jar.store(await app.dispatch(jar.request(`${BASE}/set`, { method: "POST" }), env(), { runtime: "bun" }));
    await Bun.sleep(1100);
    expect((await (await app.dispatch(jar.request(`${BASE}/get`), env(), { runtime: "bun" })).json()).n).toBeNull();
  });

  test("cloudflare() declares KV and D1 bindings named by string", () => {
    expect(session({ store: kvSessionStore("SESSIONS") }).cloudflare()).toEqual({ kv: ["SESSIONS"] });
    expect(session({ store: dbSessionStore(d1("DB")) }).cloudflare()).toEqual({ d1: ["DB"] });
    expect(session({ store: memorySessionStore() }).cloudflare()).toEqual({});
    expect(session().cloudflare()).toEqual({});
    expect(session({ store: kvSessionStore("SESSIONS") }).inspect().store).toEqual({ store: "kv", binding: "SESSIONS" });
  });
});

describe("redisSessionStore", () => {
  test("behaves like a server store, under a prefix", async () => {
    const r = fakeRedis();
    await behavesLikeAServerStore(() => ({
      store: redisSessionStore(r.client, { prefix: "app:s:" }),
      count: async () => r.keys().filter((k) => k.startsWith("app:s:")).length,
    }));
  });

  test("sets a PX expiry from the session ttl, so Redis drops expired sessions itself", async () => {
    const r = fakeRedis();
    const app = appWith(redisSessionStore(r.client), 3600);
    await app.dispatch(new Request(`${BASE}/set`, { method: "POST" }), env(), { runtime: "bun" });
    const set = r.log.find((c) => c[0] === "SET")!;
    expect(set[1].startsWith("miu:session:")).toBe(true);
    expect(set.slice(3)).toEqual(["PX", "3600000"]);
  });

  test("an expired record is not returned even if Redis still has it", async () => {
    const r = fakeRedis();
    const store = redisSessionStore(r.client);
    await store.set("id1", { d: { a: 1 }, e: Date.now() + 60_000 }, 60, {});
    expect((await store.get("id1", {}))?.d).toEqual({ a: 1 });
    await r.client.set("miu:session:id2", JSON.stringify({ d: {}, e: Date.now() - 1 }));
    expect(await store.get("id2", {})).toBeNull();
    await r.client.set("miu:session:id3", "not json");
    expect(await store.get("id3", {})).toBeNull();
  });

  test("a Redis failure is MIU_E_SESSION_REDIS with a fix", async () => {
    const r = fakeRedis();
    const app = appWith(redisSessionStore(r.client));
    r.failNext(5);
    const res = await app.dispatch(new Request(`${BASE}/set`, { method: "POST" }), env(), { runtime: "bun" });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_SESSION_REDIS");
    await expect(redisSessionStore(fakeRedis().client).get("x", {})).resolves.toBeNull();
  });

  test("rejects a non-client; inspect has the prefix and no secrets", () => {
    expect(() => redisSessionStore({} as any)).toThrow(expect.objectContaining({ code: "MIU_E_SESSION_REDIS_CLIENT" }) as any);
    const client = { ...fakeRedis().client, inspect: () => ({ url: "redis://u:***@h" }) };
    expect(redisSessionStore(client).inspect!()).toEqual({ store: "redis", prefix: "miu:session:", client: { url: "redis://u:***@h" } });
    expect(session({ store: redisSessionStore(client) }).cloudflare()).toEqual({});
  });
});
