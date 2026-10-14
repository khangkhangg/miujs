import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { HttpError } from "../../src/core/errors.ts";
import { t } from "../../src/core/schema.ts";
import { devErrors, parseStack } from "../../src/devtools/index.ts";

const PROD = { NODE_ENV: "production" };
const HTML = { accept: "text/html,application/xhtml+xml" };

function make(opts: Parameters<typeof devErrors>[0] = {}) {
  const logs: string[] = [];
  const app = new Miu({ logger: false });
  app.onError(devErrors({ log: (...a: unknown[]) => logs.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" ")), ...opts }));
  app.get("/xss", () => {
    throw new Error('<script>alert("x")</script>');
  });
  app.get("/users/:id", () => {
    const root = new TypeError("connection refused");
    throw new Error("Could not load user", { cause: new Error("db query failed", { cause: root }) });
  });
  app.get("/missing", () => {
    throw new HttpError(404, "No such tour", { code: "tour_not_found" });
  });
  app.post("/signup", { body: t.object({ name: t.string(), password: t.string() }) }, () => {
    throw new Error("signup broke");
  });
  return { app, logs };
}

const secrets = {
  authorization: "Bearer sekret-bearer",
  cookie: "sid=sekret-cookie",
  "x-api-key": "sekret-key",
  "x-csrf-token": "sekret-csrf",
  "x-my-password": "sekret-pass",
  "user-agent": "devtools-test-agent",
};

describe("devErrors() in development", () => {
  test("renders an HTML page for browsers with everything escaped", async () => {
    const { app } = make();
    const res = await app.request("/xss?q=<img src=x onerror=alert(1)>", { headers: HTML });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("Error");
    expect(html).toContain("GET");
    expect(html).toContain("test/devtools/errors.test.ts");
  });

  test("redacts secret headers, query params and body fields", async () => {
    const { app } = make();
    const res = await app.request("/signup?token=sekret-query&page=2", {
      method: "POST",
      headers: { ...HTML, ...secrets, "content-type": "application/json" },
      body: JSON.stringify({ name: "visible-name", password: "sekret-body" }),
    });
    const html = await res.text();
    expect(html).not.toContain("sekret");
    expect(html).toContain("[redacted]");
    expect(html).toContain("devtools-test-agent");
    expect(html).toContain("visible-name");
    expect(html).toContain("page");
  });

  test("returns problem+json with stack, location and cause chain for API clients", async () => {
    const { app } = make();
    const res = await app.request("/users/7", { headers: { authorization: "Bearer sekret" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = (await res.json()) as any;
    expect(body.status).toBe(500);
    expect(body.detail).toBe("Could not load user");
    expect(body.name).toBe("Error");
    expect(Array.isArray(body.stack)).toBe(true);
    expect(body.stack.join("\n")).toContain("errors.test.ts");
    expect(body.location).toMatch(/errors\.test\.ts:\d+:\d+$/);
    expect(body.cause.map((c: any) => [c.name, c.message])).toEqual([
      ["Error", "db query failed"],
      ["TypeError", "connection refused"],
    ]);
    expect(body.request).toEqual({ method: "GET", url: "http://localhost/users/7", params: { id: "7" } });
    expect(JSON.stringify(body)).not.toContain("sekret");
  });

  test("keeps the HttpError status and fields", async () => {
    const { app } = make();
    const res = await app.request("/missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.detail).toBe("No such tour");
    expect(body.code).toBe("tour_not_found");
    expect(body.stack).toBeDefined();
  });

  test("prints a clickable file:line to the console", async () => {
    const { app, logs } = make();
    await app.request("/xss");
    const out = logs.join("\n");
    expect(out).toMatch(/GET \/xss/);
    expect(out).toMatch(/\/test\/devtools\/errors\.test\.ts:\d+:\d+/);
  });
});

describe("devErrors() fallback (production / disabled)", () => {
  test("production: generic 500 without details, even for browsers", async () => {
    const { app, logs } = make();
    const res = await app.request("/xss", { headers: HTML }, PROD);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const text = await res.text();
    expect(text).not.toContain("alert");
    expect(text).not.toContain("stack");
    expect(JSON.parse(text)).toEqual({ type: "about:blank", title: "Internal Server Error", status: 500 });
    expect(logs.length).toBe(0); // app logger is off; nothing dev-specific is printed
  });

  test("production: HttpError keeps its status and public detail", async () => {
    const { app } = make();
    const res = await app.request("/missing", undefined, PROD);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ type: "about:blank", title: "Not Found", status: 404, detail: "No such tour", code: "tour_not_found" });
  });

  test("enabled: true is not enough in production; force: true is required", async () => {
    const off = await make({ enabled: true }).app.request("/xss", undefined, PROD);
    expect(await off.text()).not.toContain("stack");
    const forced = await make({ enabled: true, force: true }).app.request("/xss", undefined, PROD);
    expect(((await forced.json()) as any).stack).toBeDefined();
  });

  test("enabled: false falls back in development", async () => {
    const res = await make({ enabled: false }).app.request("/xss", { headers: HTML });
    expect(await res.json()).toEqual({ type: "about:blank", title: "Internal Server Error", status: 500 });
  });
});

describe("parseStack()", () => {
  test("parses V8/JSC frames and flags internals", () => {
    const frames = parseStack(
      [
        "Error: x",
        "    at handler (/app/src/routes.ts:12:5)",
        "    at file:///app/src/main.ts:3:1",
        "    at async dispatch (/app/node_modules/miujs/src/core/app.ts:9:9)",
        "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
        "    at <anonymous> (native)",
      ].join("\n"),
    );
    expect(frames.map((f) => [f.fn, f.file, f.line, f.column, f.internal])).toEqual([
      ["handler", "/app/src/routes.ts", 12, 5, false],
      ["", "/app/src/main.ts", 3, 1, false],
      ["async dispatch", "/app/node_modules/miujs/src/core/app.ts", 9, 9, true],
      ["processTicksAndRejections", "node:internal/process/task_queues", 95, 5, true],
    ]);
  });
});
