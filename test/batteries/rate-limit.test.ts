import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { memoryStore } from "../../src/batteries/store/index.ts";
import { rateLimit } from "../../src/batteries/rate-limit.ts";

const setup = (opts: Partial<Parameters<typeof rateLimit>[0]> = {}) => {
  let t = 1_000_000;
  const store = memoryStore({ now: () => t });
  const app = new Miu({ logger: false });
  app.use(rateLimit({ store, limit: 3, window: 60, ...opts }));
  app.get("/x", () => "ok");
  const hit = (ip = "1.1.1.1", headers: Record<string, string> = {}) =>
    app.request("/x", { headers: { "cf-connecting-ip": ip, ...headers } });
  return { app, store, hit, advance: (ms: number) => (t += ms) };
};

describe("rateLimit", () => {
  test("sets RateLimit headers", async () => {
    const { hit } = setup();
    const res = await hit();
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-limit")).toBe("3");
    expect(res.headers.get("ratelimit-remaining")).toBe("2");
    expect(res.headers.get("ratelimit-reset")).toBe("60");
  });

  test("429 problem+json at limit + 1", async () => {
    const { hit, advance } = setup();
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    advance(48_000);
    const res = await hit();
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
    expect(res.headers.get("ratelimit-reset")).toBe("12");
    const body = await res.json();
    expect(body.status).toBe(429);
    expect(body.code).toBe("rate_limited");
    expect(body.detail).toBe("Rate limit of 3 requests per 60s exceeded. Retry after 12s.");
  });

  test("resets after the window", async () => {
    const { hit, advance } = setup();
    for (let i = 0; i < 4; i++) await hit();
    expect((await hit()).status).toBe(429);
    advance(60_000);
    const res = await hit();
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-remaining")).toBe("2");
  });

  test("keys are isolated per client IP", async () => {
    const { hit } = setup({ limit: 1 });
    expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(429);
    expect((await hit("2.2.2.2")).status).toBe(200);
  });

  test("falls back to x-forwarded-for then x-real-ip", async () => {
    const { app } = setup({ limit: 1 });
    const xff = (v: string) => app.request("/x", { headers: { "x-forwarded-for": v } });
    expect((await xff("9.9.9.9, 10.0.0.1")).status).toBe(200);
    expect((await xff("9.9.9.9, 10.0.0.2")).status).toBe(429);
    expect((await xff("8.8.8.8")).status).toBe(200);
    expect((await app.request("/x", { headers: { "x-real-ip": "7.7.7.7" } })).status).toBe(200);
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(429);
  });

  test("custom key, prefix and skip", async () => {
    const { app, store } = setup({
      limit: 1,
      key: (c) => c.req.headers.get("x-api-key") ?? "none",
      prefix: "api:",
      skip: (c) => c.req.headers.get("x-internal") === "1",
    });
    const call = (key: string, extra: Record<string, string> = {}) =>
      app.request("/x", { headers: { "x-api-key": key, ...extra } });
    expect((await call("k1")).status).toBe(200);
    expect((await call("k1")).status).toBe(429);
    expect((await call("k2")).status).toBe(200);
    expect(await store.get("api:k1")).toBe(2);
    const skipped = await call("k1", { "x-internal": "1" });
    expect(skipped.status).toBe(200);
    expect(skipped.headers.get("ratelimit-limit")).toBeNull();
  });
});
