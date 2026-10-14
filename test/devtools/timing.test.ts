import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { HttpError } from "../../src/core/errors.ts";
import { getTiming, timing, type Timing } from "../../src/devtools/index.ts";

const PROD = { NODE_ENV: "production" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(opts?: Parameters<typeof timing>[0]) {
  const app = new Miu({ logger: false });
  app.use(timing(opts));
  app.get("/plain", () => "ok");
  app.get("/marks", async (c) => {
    const t = c.get("timing") as Timing;
    t.start("db", "Query users");
    await sleep(5);
    t.end("db");
    const v = await t.measure("cache", async () => {
      await sleep(2);
      return 42;
    });
    t.add("cdn-hit", undefined, "edge");
    t.add("weird name/ü;=x", 1.234, 'say "hi"\\ \n there');
    return { v };
  });
  app.get("/open", (c) => {
    getTiming(c).start("never-ended");
    return "ok";
  });
  app.get("/boom", (c) => {
    getTiming(c).add("before", 1);
    throw new HttpError(409, "conflict");
  });
  app.get("/existing", (c) => {
    c.header("server-timing", "app;dur=1");
    return "ok";
  });
  return app;
}

const metrics = (h: string | null) => (h ?? "").split(/,\s*/).filter(Boolean);

describe("timing()", () => {
  test("adds total;dur in development", async () => {
    const res = await make().request("/plain");
    expect(res.headers.get("server-timing")).toMatch(/^total;dur=\d+(\.\d+)?$/);
  });

  test("records marks, measure() results and descriptions", async () => {
    const res = await make().request("/marks");
    expect(await res.json()).toEqual({ v: 42 });
    const m = metrics(res.headers.get("server-timing"));
    const db = m.find((x) => x.startsWith("db;"))!;
    expect(db).toMatch(/^db;desc="Query users";dur=\d+(\.\d+)?$/);
    expect(Number(db.split("dur=")[1])).toBeGreaterThanOrEqual(4);
    expect(m.find((x) => x.startsWith("cache;"))).toMatch(/^cache;dur=\d/);
    expect(m).toContain('cdn-hit;desc="edge"');
    expect(m.at(-1)).toMatch(/^total;dur=/);
  });

  test("sanitizes metric names and descriptions per the header grammar", async () => {
    const res = await make().request("/marks");
    const h = res.headers.get("server-timing")!;
    expect(h).toContain('weird_name____x;desc="say \\"hi\\"\\\\ ? there";dur=1.2');
    expect(h).not.toContain("ü");
  });

  test("unfinished timers are closed at the end of the request", async () => {
    const res = await make().request("/open");
    expect(res.headers.get("server-timing")).toMatch(/never-ended;dur=\d/);
  });

  test("error responses still carry Server-Timing", async () => {
    const res = await make().request("/boom");
    expect(res.status).toBe(409);
    expect(res.headers.get("server-timing")).toMatch(/^before;dur=1, total;dur=/);
  });

  test("appends to a Server-Timing header set by the handler", async () => {
    const res = await make().request("/existing");
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=1, total;dur=/);
  });

  test("is off by default in production (leaks internal timings) but the helper still works", async () => {
    const res = await make().request("/marks", undefined, PROD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 42 });
    expect(res.headers.get("server-timing")).toBeNull();
  });

  test("can be explicitly enabled in production, with Timing-Allow-Origin", async () => {
    const res = await make({ enabled: true, allowOrigin: "https://app.example" }).request("/plain", undefined, PROD);
    expect(res.headers.get("server-timing")).toMatch(/^total;dur=/);
    expect(res.headers.get("timing-allow-origin")).toBe("https://app.example");
  });

  test("enabled: false turns it off in development", async () => {
    const res = await make({ enabled: false }).request("/plain");
    expect(res.headers.get("server-timing")).toBeNull();
  });

  test("getTiming() returns a no-op timer without the middleware", async () => {
    const app = new Miu({ logger: false });
    app.get("/", async (c) => {
      const t = getTiming(c);
      t.start("x");
      t.end("x");
      return await t.measure("y", () => 7);
    });
    const res = await app.request("/");
    expect(await res.json()).toBe(7);
    expect(res.headers.get("server-timing")).toBeNull();
  });
});
