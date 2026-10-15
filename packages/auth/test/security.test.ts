import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { session } from "@miujs/session";
import { auth, cloudflareRateLimiter, memoryRateLimiter } from "../src/index.ts";

const SECRET = "test-secret-that-is-long-enough-0123456789";
const PW = { algorithm: "pbkdf2" as const, iterations: 1000 };

function makeApp(extra: Parameters<typeof auth>[0] = {}) {
  return miu({ logLevel: "silent", plugins: [session({ secret: SECRET }), auth({ password: PW, ...extra })] });
}

function post(app: ReturnType<typeof makeApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("login CSRF", () => {
  test("a cross-site form cannot log a browser in", async () => {
    const app = makeApp();
    await post(app, "/auth/register", { email: "a@example.com", password: "password-a" });
    const res = await post(app, "/auth/login", { email: "a@example.com", password: "password-a" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a cross-site form cannot register an account", async () => {
    const res = await post(makeApp(), "/auth/register", { email: "b@example.com", password: "password-b" }, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
  });

  test("same-origin login still works", async () => {
    const app = makeApp();
    await post(app, "/auth/register", { email: "c@example.com", password: "password-c" });
    expect((await post(app, "/auth/login", { email: "c@example.com", password: "password-c" }, { origin: "http://localhost" })).status).toBe(200);
  });
});

describe("rate limiting", () => {
  const ip = (n: number) => ({ "cf-connecting-ip": `203.0.113.${n}` });

  test("repeated failed logins for one account from one IP get 429 with Retry-After", async () => {
    const app = makeApp({ rateLimit: { trustProxyHeader: "cf-connecting-ip" } });
    await post(app, "/auth/register", { email: "d@example.com", password: "password-d" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(app, "/auth/login", { email: "d@example.com", password: "wrong-password" }, ip(1))).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    const blocked = await post(app, "/auth/login", { email: "d@example.com", password: "password-d" }, ip(1));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).error.code).toBe("MIU_E_RATE_LIMITED");
  });

  test("the limit for one IP does not lock the account for other IPs", async () => {
    const app = makeApp({ rateLimit: { trustProxyHeader: "cf-connecting-ip" } });
    await post(app, "/auth/register", { email: "e@example.com", password: "password-e" });
    for (let i = 0; i < 11; i++) await post(app, "/auth/login", { email: "e@example.com", password: "wrong-password" }, ip(2));
    expect((await post(app, "/auth/login", { email: "e@example.com", password: "password-e" }, ip(3))).status).toBe(200);
  });

  test("one IP trying many accounts is limited", async () => {
    const app = makeApp({ rateLimit: { trustProxyHeader: "cf-connecting-ip", login: { perIp: 5 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(app, "/auth/login", { email: `user${i}@example.com`, password: "whatever-1" }, ip(4))).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  test("registration is limited per IP", async () => {
    const app = makeApp({ rateLimit: { trustProxyHeader: "cf-connecting-ip", register: { perIp: 3 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(app, "/auth/register", { email: `r${i}@example.com`, password: "password-r" }, ip(5))).status);
    expect(statuses).toEqual([201, 201, 201, 429]);
  });

  test("without a trusted client IP, per-IP limits are skipped but per-account limits apply", async () => {
    const app = makeApp({ rateLimit: { login: { perIp: 1 } } });
    // Different emails from an unknown IP: not limited by the per-IP rule.
    expect((await post(app, "/auth/login", { email: "x1@example.com", password: "whatever-1" })).status).toBe(401);
    expect((await post(app, "/auth/login", { email: "x2@example.com", password: "whatever-1" })).status).toBe(401);
  });

  test("rate limiting can be turned off", async () => {
    const app = makeApp({ rateLimit: false });
    for (let i = 0; i < 12; i++) expect((await post(app, "/auth/login", { email: "f@example.com", password: "wrong-password" })).status).toBe(401);
  });

  test("memoryRateLimiter counts per key within the window", async () => {
    let now = 0;
    const rl = memoryRateLimiter({ now: () => now });
    expect((await rl.hit("k", 2, 60)).ok).toBe(true);
    expect((await rl.hit("k", 2, 60)).ok).toBe(true);
    const third = await rl.hit("k", 2, 60);
    expect(third.ok).toBe(false);
    expect(third.retryAfter).toBe(60);
    now = 61_000;
    expect((await rl.hit("k", 2, 60)).ok).toBe(true);
  });
});

describe("cloudflareRateLimiter", () => {
  test("uses the binding's verdict per key", async () => {
    const seen: string[] = [];
    const env = { LOGIN_LIMIT: { limit: async ({ key }: { key: string }) => (seen.push(key), { success: seen.length <= 1 }) } };
    const rl = cloudflareRateLimiter("LOGIN_LIMIT");
    expect((await rl.hit("a", 10, 60, env)).ok).toBe(true);
    expect((await rl.hit("a", 10, 60, env)).ok).toBe(false);
    expect(seen).toEqual(["a", "a"]);
  });

  test("a missing binding fails loudly instead of allowing everything", async () => {
    await expect(cloudflareRateLimiter("NOPE").hit("a", 10, 60, {})).rejects.toMatchObject({ code: "MIU_E_AUTH_RATELIMIT_BINDING" });
  });
});
