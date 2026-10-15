// Memory and CPU health of auth: login attempts from many IPs and emails, OAuth round trips, API
// token requests, the sign-in rate limiter and the memory store's lookups.
import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { session } from "@miujs/session";
import { describeLeak, leakCheck } from "../../../scripts/lib/leak.ts";
import { auth, memoryRateLimiter, memoryUserStore } from "../src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";
import { fakeOidc } from "./oauth-fakes.ts";

const FAST = { algorithm: "pbkdf2" as const, iterations: 1 };
const report = (r: { name: string }) => process.env.LEAK_REPORT && console.log(describeLeak(r as never));
const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", ...headers }, body: JSON.stringify(body) });

describe("memoryRateLimiter", () => {
  test("expired windows are pruned before the limiter fills up", async () => {
    let now = 0;
    const rl = memoryRateLimiter({ now: () => now });
    const r = await leakCheck(
      "auth limiter, moving clock",
      async (i) => {
        now += 1000;
        await rl.hit(`login:ip:${i}`, 10, 60);
      },
      { perRound: 3000, rounds: 5 },
    );
    report(r);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);

  test("a flood of distinct keys within one window stays at maxKeys", async () => {
    const rl = memoryRateLimiter({ now: () => 0, maxKeys: 1000 });
    const r = await leakCheck("auth limiter flood", (i) => rl.hit(`login:account:user${i}@example.com`, 10, 900), { perRound: 3000, rounds: 5 });
    report(r);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);

  test("a flood of distinct keys cannot reset a blocked account", async () => {
    const rl = memoryRateLimiter({ now: () => 0, maxKeys: 100 });
    for (let i = 0; i < 3; i++) await rl.hit("login:account:victim@example.com", 3, 900);
    expect((await rl.hit("login:account:victim@example.com", 3, 900)).ok).toBe(false);
    for (let i = 0; i < 5000; i++) await rl.hit(`login:account:junk${i}@example.com`, 3, 900);
    expect((await rl.hit("login:account:victim@example.com", 3, 900)).ok).toBe(false);
  });

  test("a full limiter does not scan every key on each new key", async () => {
    const rl = memoryRateLimiter({ now: () => 0, maxKeys: 20_000 });
    for (let i = 0; i < 20_000; i++) await rl.hit(`fill${i}`, 10, 900);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) await rl.hit(`flood${i}`, 10, 900);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

test("login attempts from many IPs and emails plateau (windows expire on a fake clock)", async () => {
  let now = 0;
  // A small maxKeys keeps the sweep sawtooth (size between the live count and the next sweep
  // point) well under the leak threshold; ~90 windows are live at any time.
  const rl = memoryRateLimiter({ now: () => now, maxKeys: 300 });
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [session({ secret: SECRET }), auth({ password: FAST, rateLimit: { limiter: rl, trustProxyHeader: "x-real-ip", login: { windowSeconds: 60 } } })],
  });
  await app.ready();
  await (await app.fetch(json("/auth/register", { email: "real@example.com", password: "correct horse battery" }))).arrayBuffer();
  const r = await leakCheck(
    "login attempts",
    async (i) => {
      now += 2000; // 1-min windows: ~30 live windows of each kind
      const ok = i % 10 === 0;
      const res = await app.fetch(
        json("/auth/login", { email: ok ? "real@example.com" : `user${i}@example.com`, password: ok ? "correct horse battery" : "wrong password" }, { "x-real-ip": `10.0.${(i >> 8) & 255}.${i & 255}` }),
      );
      await res.arrayBuffer();
    },
    { perRound: 4000, rounds: 6, warmup: 3000 },
  );
  report(r);
  expect(r.leaking, describeLeak(r)).toBe(false);
  expect(rl.size).toBeLessThanOrEqual(300);
}, 120_000);

test("OAuth start/callback cycles plateau", async () => {
  const idp = await fakeOidc({ issuer: "https://idp.example", clientId: "c", clientSecret: "s", alg: "ES256" });
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return (await idp.handle(req, new URL(req.url))) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [
      session({ secret: SECRET }),
      auth({
        password: FAST,
        appUrl: "http://localhost",
        oauth: { fetch: net, secret: SECRET, oidc: [{ id: "idp", issuer: "https://idp.example", clientId: "c", clientSecret: "s", scopes: ["openid", "email"] }] },
      }),
    ],
  });
  await app.ready();
  const r = await leakCheck(
    "oauth cycle",
    async (i) => {
      const jar = new Jar();
      const st = await app.fetch(jar.request("http://localhost/auth/oauth/idp"));
      jar.store(st);
      const url = new URL(st.headers.get("location")!);
      const code = idp.authorize(url, { sub: `u${i % 20}`, email: `u${i % 20}@example.com`, email_verified: true });
      const cb = await app.fetch(jar.request(`http://localhost/auth/oauth/idp/callback?code=${code}&state=${url.searchParams.get("state")}`));
      if (cb.status !== 302) throw new Error(`callback ${cb.status}: ${await cb.text()}`);
      await cb.arrayBuffer();
    },
    { perRound: 1000, rounds: 6, warmup: 300 },
  );
  report(r);
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 120_000);

test("API-token requests plateau", async () => {
  const app = miu({ logLevel: "silent", dev: false, plugins: [session({ secret: SECRET }), auth({ password: FAST })] });
  await app.ready();
  const jar = new Jar();
  jar.store(await app.fetch(jar.request("http://localhost/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "t@example.com", password: "correct horse battery" }) })));
  const created = await app.fetch(jar.request("http://localhost/auth/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ci" }) }));
  const { token } = (await created.json()) as { token: string };
  const r = await leakCheck(
    "api token",
    async (i) => {
      const bad = i % 5 === 0;
      const res = await app.fetch(new Request("http://localhost/auth/me", { headers: { authorization: `Bearer ${bad ? "miu_nope" : token}` } }));
      if (res.status !== (bad ? 401 : 200)) throw new Error(`status ${res.status}`);
      await res.arrayBuffer();
    },
    { perRound: 3000, rounds: 5 },
  );
  report(r);
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 60_000);

describe("memoryUserStore", () => {
  test("token lookups do not scan every token", async () => {
    const users = memoryUserStore();
    for (let i = 0; i < 50_000; i++) await users.createToken({ id: `t${i}`, userId: "u", name: "n", tokenHash: `h${i}`, createdAt: 0, expiresAt: null }, {});
    const started = performance.now();
    for (let i = 0; i < 5_000; i++) expect((await users.findTokenByHash(`h${(i * 7) % 50_000}`, {}))?.id).toBe(`t${(i * 7) % 50_000}`);
    expect(await users.findTokenByHash("missing", {})).toBeNull();
    // Deleted tokens are gone from the index too.
    await users.deleteToken("t1", "u", {});
    expect(await users.findTokenByHash("h1", {})).toBeNull();
    await users.deleteUserTokens!("u", {});
    expect(await users.findTokenByHash("h2", {})).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("storing a passkey challenge does not scan every live challenge", async () => {
    const users = memoryUserStore();
    const now = Date.now();
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) await users.createChallenge!({ challenge: `c${i}`, purpose: "passkey-login", userId: null, createdAt: now, expiresAt: now + 300_000 }, {});
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await users.consumeChallenge!("c5", "passkey-login", {})).not.toBeNull();
  });

  test("expired passkey challenges are dropped", async () => {
    const users = memoryUserStore();
    const r = await leakCheck(
      "expired challenges",
      (i) => users.createChallenge!({ challenge: `c${i}`, purpose: "passkey-login", userId: null, createdAt: 0, expiresAt: 1 }, {}),
      { perRound: 3000, rounds: 5 },
    );
    report(r);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);
});
