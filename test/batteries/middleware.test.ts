import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { HttpError } from "../../src/core/errors.ts";
import { cors, logger, requestId, secureHeaders } from "../../src/batteries/http.ts";

describe("cors", () => {
  const make = (opts?: Parameters<typeof cors>[0]) => {
    const app = new Miu({ logger: false });
    app.use(cors(opts));
    app.get("/x", () => ({ ok: true }));
    app.post("/x", () => ({ ok: true }));
    return app;
  };

  test("default allows any origin with *", async () => {
    const res = await make().request("/x", { headers: { origin: "https://a.com" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBeNull();
  });

  test("preflight short-circuits with 204 and echoes requested headers", async () => {
    const res = await make({ maxAge: 600 }).request("/x", {
      method: "OPTIONS",
      headers: {
        origin: "https://a.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-api-key",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,HEAD,PUT,POST,DELETE,PATCH");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type, x-api-key");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  test("preflight uses configured allowHeaders", async () => {
    const res = await make({ allowHeaders: ["X-One", "X-Two"] }).request("/x", {
      method: "OPTIONS",
      headers: { origin: "https://a.com", "access-control-request-method": "POST", "access-control-request-headers": "x-evil" },
    });
    expect(res.headers.get("access-control-allow-headers")).toBe("X-One,X-Two");
  });

  test("credentials reflect the origin instead of *", async () => {
    const res = await make({ credentials: true, exposeHeaders: ["x-total"] }).request("/x", { headers: { origin: "https://a.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://a.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-expose-headers")).toBe("x-total");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("allow-list reflects matching origin and ignores others", async () => {
    const app = make({ origin: ["https://a.com", "https://b.com"] });
    const ok = await app.request("/x", { headers: { origin: "https://b.com" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://b.com");
    expect(ok.headers.get("vary")).toContain("Origin");
    const bad = await app.request("/x", { headers: { origin: "https://evil.com" } });
    expect(bad.status).toBe(200);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await app.request("/x", {
      method: "OPTIONS",
      headers: { origin: "https://evil.com", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    expect(pre.headers.get("access-control-allow-methods")).toBeNull();
  });

  test("origin function", async () => {
    const app = make({ origin: (o) => o.endsWith(".example.com") });
    const ok = await app.request("/x", { headers: { origin: "https://app.example.com" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    const bad = await app.request("/x", { headers: { origin: "https://example.org" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("single string origin", async () => {
    const app = make({ origin: "https://a.com" });
    const ok = await app.request("/x", { headers: { origin: "https://a.com" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://a.com");
    const bad = await app.request("/x", { headers: { origin: "https://b.com" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("secureHeaders", () => {
  const make = (opts?: Parameters<typeof secureHeaders>[0]) => {
    const app = new Miu({ logger: false });
    app.use(secureHeaders(opts));
    app.get("/x", (c) => {
      c.header("x-frame-options", "DENY");
      return "hi";
    });
    app.get("/y", () => "hi");
    return app;
  };

  test("sets defaults, no HSTS over http", async () => {
    const res = await make().request("/y");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("HSTS only on https", async () => {
    const res = await make().request("https://example.com/y");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=15552000; includeSubDomains");
  });

  test("does not overwrite handler headers", async () => {
    const res = await make().request("/x");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("override and disable", async () => {
    const res = await make({
      xFrameOptions: false,
      referrerPolicy: "no-referrer",
      contentSecurityPolicy: "default-src 'self'",
      strictTransportSecurity: false,
    }).request("https://example.com/y");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  test("applies to 404 responses too", async () => {
    const res = await make().request("/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("requestId", () => {
  const make = (opts?: Parameters<typeof requestId>[0]) => {
    const app = new Miu({ logger: false });
    app.use(requestId(opts));
    app.get("/x", (c) => ({ id: c.get("requestId") }));
    return app;
  };

  test("generates a uuid when none is given", async () => {
    const res = await make().request("/x");
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toEqual({ id });
  });

  test("reuses a valid incoming id", async () => {
    const res = await make().request("/x", { headers: { "x-request-id": "abc-123.x:y_z" } });
    expect(res.headers.get("x-request-id")).toBe("abc-123.x:y_z");
    expect(await res.json()).toEqual({ id: "abc-123.x:y_z" });
  });

  test("regenerates when incoming id is invalid", async () => {
    for (const bad of ["has space", "<script>", "x".repeat(129)]) {
      const res = await make({ generate: () => "fresh" }).request("/x", { headers: { "x-request-id": bad } });
      expect(res.headers.get("x-request-id")).toBe("fresh");
    }
  });

  test("custom header name", async () => {
    const res = await make({ header: "x-trace" }).request("/x", { headers: { "x-trace": "t1" } });
    expect(res.headers.get("x-trace")).toBe("t1");
  });
});

describe("logger", () => {
  const make = (format?: "json" | "pretty") => {
    const lines: string[] = [];
    const app = new Miu({ logger: false });
    app.use(requestId({ generate: () => "rid-1" }));
    app.use(logger({ write: (l) => lines.push(l), format }));
    app.get("/x", () => "ok");
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.get("/teapot", () => {
      throw new HttpError(418, "short and stout");
    });
    return { app, lines };
  };

  test("json line", async () => {
    const { app, lines } = make();
    await app.request("/x?q=1");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/x");
    expect(entry.status).toBe(200);
    expect(entry.requestId).toBe("rid-1");
    expect(typeof entry.duration).toBe("number");
    expect(Math.round(entry.duration * 10) / 10).toBe(entry.duration);
    expect(new Date(entry.time).toISOString()).toBe(entry.time);
  });

  test("logs 404s", async () => {
    const { app, lines } = make();
    await app.request("/nope");
    expect(JSON.parse(lines[0]!).status).toBe(404);
  });

  test("logs thrown errors as 500 / HttpError status", async () => {
    const { app, lines } = make();
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(JSON.parse(lines[0]!).status).toBe(500);
    await app.request("/teapot");
    expect(JSON.parse(lines[1]!).status).toBe(418);
  });

  test("pretty format", async () => {
    const { app, lines } = make("pretty");
    await app.request("/x");
    expect(lines[0]).toMatch(/^GET \/x 200 \d+(\.\d)?ms rid-1$/);
  });
});
