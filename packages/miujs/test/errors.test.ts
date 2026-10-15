import { describe, expect, test } from "bun:test";
import { DOCS_BASE, MiuError, errors, isMiuError } from "../src/errors.ts";

describe("MiuError", () => {
  test("carries code, status, fix, details, cause and is an Error", () => {
    const cause = new Error("root");
    const e = new MiuError({ code: "MIU_E_X", status: 418, message: "nope", fix: "do y", details: { a: 1 }, cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("MiuError");
    expect(e.message).toBe("nope");
    expect(e.code).toBe("MIU_E_X");
    expect(e.status).toBe(418);
    expect(e.fix).toBe("do y");
    expect(e.details).toEqual({ a: 1 });
    expect(e.cause).toBe(cause);
    expect(isMiuError(e)).toBe(true);
    expect(isMiuError(new Error("x"))).toBe(false);
  });

  test("toJSON shape with all fields, in order", () => {
    const e = new MiuError({ code: "MIU_E_X", status: 400, message: "m", fix: "f", details: [1] });
    const j = e.toJSON();
    expect(j).toEqual({ error: { code: "MIU_E_X", message: "m", fix: "f", docs: DOCS_BASE + "MIU_E_X", details: [1] } });
    expect(Object.keys(j.error)).toEqual(["code", "message", "fix", "docs", "details"]);
    expect(JSON.stringify(e)).toBe(JSON.stringify(j));
  });

  test("toJSON omits fix and details when absent", () => {
    const j = new MiuError({ code: "MIU_E_Y", status: 500, message: "m" }).toJSON();
    expect(j).toEqual({ error: { code: "MIU_E_Y", message: "m", docs: "https://miujs.dev/errors/MIU_E_Y" } });
    expect("fix" in j.error).toBe(false);
    expect("details" in j.error).toBe(false);
  });

  test("toResponse sets status, JSON content-type and keeps extra headers", async () => {
    const e = errors.notFound("User", 7);
    const res = e.toResponse({ "x-req": "1", "content-type": "text/plain" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-req")).toBe("1");
    expect(await res.json()).toEqual(e.toJSON());
  });
});

describe("errors factories", () => {
  test("notFound", () => {
    expect(errors.notFound("User", 7).message).toBe("User 7 not found");
    expect(errors.notFound("User", "a").message).toBe('User "a" not found');
    const e = errors.notFound("Page");
    expect(e.message).toBe("Page not found");
    expect([e.code, e.status]).toEqual(["MIU_E_NOT_FOUND", 404]);
  });

  test("badRequest", () => {
    const e = errors.badRequest("bad", "fix it", { x: 1 });
    expect([e.code, e.status, e.fix, e.details]).toEqual(["MIU_E_BAD_REQUEST", 400, "fix it", { x: 1 }]);
  });

  test("validation for request parts", () => {
    const issues = [
      { path: "body.items.2.qty", message: "must be >= 1" },
      { path: "", message: "expected object, got string" },
    ];
    const e = errors.validation("body", issues);
    expect(e.code).toBe("MIU_E_VALIDATION");
    expect(e.status).toBe(400);
    expect(e.message).toBe("Invalid body: body.items.2.qty must be >= 1; body expected object, got string");
    expect(e.details).toEqual({ where: "body", issues });
    expect(e.fix).toContain("/_miu/openapi.json");
  });

  test("validation message lists at most 5 issues but details keeps all", () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({ path: `p${i}`, message: "bad" }));
    const e = errors.validation("query", issues);
    expect(e.message.split("; ").length).toBe(5);
    expect(e.message).not.toContain("p5");
    expect((e.details as { issues: unknown[] }).issues.length).toBe(7);
  });

  test("validation of response is a 500 with its own code", () => {
    const e = errors.validation("response", [{ path: "id", message: "is required" }]);
    expect([e.code, e.status]).toEqual(["MIU_E_RESPONSE_INVALID", 500]);
    expect(e.fix).toContain("handler");
  });

  test("unauthorized / forbidden / conflict defaults", () => {
    const u = errors.unauthorized();
    expect([u.code, u.status, u.message]).toEqual(["MIU_E_UNAUTHORIZED", 401, "Authentication required"]);
    expect(u.fix).toContain("Bearer");
    const f = errors.forbidden();
    expect([f.code, f.status, f.fix]).toEqual(["MIU_E_FORBIDDEN", 403, undefined]);
    const c = errors.conflict("taken", "pick another");
    expect([c.code, c.status, c.message, c.fix]).toEqual(["MIU_E_CONFLICT", 409, "taken", "pick another"]);
  });

  test("tooManyRequests with and without retryAfter", () => {
    const a = errors.tooManyRequests(30);
    expect([a.code, a.status, a.fix, a.details]).toEqual(["MIU_E_RATE_LIMITED", 429, "Retry after 30 seconds.", { retryAfter: 30 }]);
    const b = errors.tooManyRequests();
    expect(b.fix).toBe("Slow down and retry later.");
    expect(b.details).toBeUndefined();
    expect("details" in b.toJSON().error).toBe(false);
  });

  test("internal keeps cause but does not expose it in JSON", () => {
    const cause = new Error("db down");
    const e = errors.internal(undefined, cause);
    expect([e.code, e.status, e.message]).toEqual(["MIU_E_INTERNAL", 500, "Internal server error"]);
    expect(e.cause).toBe(cause);
    expect(JSON.stringify(e)).not.toContain("db down");
  });

  test("config and custom", () => {
    const c = errors.config("MIU_E_ROUTE_DUPLICATE", "dup", "rename", { p: "/a" });
    expect([c.code, c.status, c.message, c.fix, c.details]).toEqual(["MIU_E_ROUTE_DUPLICATE", 500, "dup", "rename", { p: "/a" }]);
    const x = errors.custom({ code: "APP_E_X", status: 402, message: "pay" });
    expect(x).toBeInstanceOf(MiuError);
    expect([x.code, x.status]).toEqual(["APP_E_X", 402]);
  });
});
