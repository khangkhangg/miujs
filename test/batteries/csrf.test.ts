import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { csrf } from "../../src/batteries/csrf.ts";

const make = (opts?: Parameters<typeof csrf>[0]) =>
  new Miu({ logger: false }).use(csrf(opts)).post("/save", () => "saved").get("/page", () => "page");

const post = (app: Miu<any>, headers: Record<string, string>, body = "a=1") =>
  app.request("http://app.test/save", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });

describe("csrf()", () => {
  test("same-origin HTML form posts with a session cookie pass", async () => {
    expect((await post(make(), { cookie: "sid=1", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post(make(), { cookie: "sid=1", origin: "http://app.test" })).status).toBe(200);
  });

  test("cross-site form posts riding on cookies are refused (403 problem+json)", async () => {
    const r = await post(make(), { cookie: "sid=1", "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("csrf");
    // Browsers without Sec-Fetch-Site: Origin must match
    expect((await post(make(), { cookie: "sid=1", origin: "https://evil.test" })).status).toBe(403);
    expect((await post(make(), { cookie: "sid=1", origin: "null" })).status).toBe(403);
  });

  test("trusted origins, bearer auth, cookie-less requests and safe methods pass", async () => {
    expect((await post(make({ trustedOrigins: ["https://admin.app.test"] }), { cookie: "sid=1", origin: "https://admin.app.test", "sec-fetch-site": "same-site" })).status).toBe(200);
    expect((await post(make(), { authorization: "Bearer t", "sec-fetch-site": "cross-site" })).status).toBe(200);
    expect((await post(make(), { "sec-fetch-site": "cross-site" })).status).toBe(200);
    expect((await make().request("http://app.test/page", { headers: { cookie: "sid=1", "sec-fetch-site": "cross-site" } })).status).toBe(200);
  });

  test("same-site but cross-origin is refused unless trusted", async () => {
    expect((await post(make(), { cookie: "sid=1", "sec-fetch-site": "same-site", origin: "https://sub.app.test" })).status).toBe(403);
  });

  test("requireNonSimple (APIs) also demands X-Requested-With or a JSON body", async () => {
    const app = make({ requireNonSimple: true });
    expect((await post(app, { cookie: "sid=1", "sec-fetch-site": "same-origin" })).status).toBe(403);
    expect((await post(app, { cookie: "sid=1", "sec-fetch-site": "same-origin", "x-requested-with": "fetch" })).status).toBe(200);
    expect((await post(app, { cookie: "sid=1", "sec-fetch-site": "same-origin", "content-type": "application/json" }, "{}")).status).toBe(200);
  });
});
