import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { miu, route, t } from "miujs";
import type { CaptureEntry } from "../src/capture.ts";
import { diffJson, formatReport, matchesIgnore, verifyContracts } from "../src/verify.ts";

describe("diffJson", () => {
  test("equal values have no diffs", () => {
    expect(diffJson({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toEqual([]);
  });
  test("reports changed, added, removed and type changes with paths", () => {
    const diffs = diffJson({ id: 1, name: "a", tags: ["x", "y"], meta: { n: 1 }, gone: true }, { id: "1", name: "b", tags: ["x"], meta: { n: 1, extra: 2 } });
    expect(diffs).toEqual([
      { path: "$.id", kind: "type", old: 1, new: "1" },
      { path: "$.name", kind: "changed", old: "a", new: "b" },
      { path: "$.tags[1]", kind: "removed", old: "y" },
      { path: "$.meta.extra", kind: "added", new: 2 },
      { path: "$.gone", kind: "removed", old: true },
    ]);
  });
  test("odd keys are quoted", () => {
    expect(diffJson({ "a b": 1 }, { "a b": 2 })[0].path).toBe('$["a b"]');
  });
  test("ignore paths with wildcards and recursive descent", () => {
    const a = { createdAt: 1, items: [{ id: 1, updatedAt: 1 }, { id: 2, updatedAt: 2 }], meta: { x: 1, y: 2 }, deep: { k: { stamp: 1 } } };
    const b = { createdAt: 2, items: [{ id: 1, updatedAt: 9 }, { id: 2, updatedAt: 8 }], meta: { x: 5, y: 6 }, deep: { k: { stamp: 2 } } };
    expect(diffJson(a, b, ["$.createdAt", "$.items[*].updatedAt", "$.meta.*", "$..stamp"])).toEqual([]);
    expect(diffJson(a, b, ["$.items[0].updatedAt"]).map((d) => d.path)).toEqual(["$.createdAt", "$.items[1].updatedAt", "$.meta.x", "$.meta.y", "$.deep.k.stamp"]);
  });
  test("matchesIgnore", () => {
    expect(matchesIgnore("$.a.b", ["$.a"])).toBe(true); // ignoring a node ignores its children
    expect(matchesIgnore("$.ab", ["$.a"])).toBe(false);
    expect(matchesIgnore('$["x y"][3]', ['$["x y"][*]'])).toBe(true);
  });
});

// Old app (a real HTTP server) and the new MiuJS app, differing in one route.
let old: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  old = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/users/1") return Response.json({ id: 1, name: "Ann", createdAt: "2020-01-01", auth: req.headers.get("cookie") });
      if (url.pathname === "/users") return Response.json({ created: (await req.json()).name }, { status: 201 });
      if (url.pathname === "/orders") return Response.json({ total: "10.50", items: [{ sku: "a", updatedAt: 1 }] });
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  });
});
afterAll(() => old.stop(true));

const newApp = miu({
  logLevel: "silent",
  routes: [
    route.get("/users/:id", { params: t.object({ id: t.string() }), handler: ({ params, headers }) => ({ id: Number(params.id), name: "Ann", createdAt: "2026-10-15", auth: headers.get("cookie") }) }),
    route.post("/users", { body: t.object({ name: t.string() }), status: 201, handler: ({ body }) => ({ created: body.name }) }),
    route.get("/orders", { handler: () => ({ total: 10.5, items: [{ sku: "a", updatedAt: 2 }] }) }),
  ],
});

function c(method: string, path: string, extra: Partial<CaptureEntry> = {}): CaptureEntry {
  return { v: 1, ts: "", method, path, query: {}, headers: {}, body: null, status: 0, responseHeaders: {}, response: null, durationMs: 0, servedBy: "proxy", route: null, ...extra };
}

describe("verifyContracts", () => {
  test("replays each case against both and diffs", async () => {
    const report = await verifyContracts({
      cases: [c("GET", "/users/1"), c("POST", "/users", { headers: { "content-type": "application/json" }, body: { name: "Bo" } }), c("GET", "/orders")],
      old: `http://127.0.0.1:${old.port}`,
      new: newApp,
      ignore: ["$.createdAt", "$.items[*].updatedAt"],
    });
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    const orders = report.results.find((r) => r.path === "/orders")!;
    expect(orders.ok).toBe(false);
    expect(orders.diffs).toEqual([{ path: "$.total", kind: "type", old: "10.50", new: 10.5 }]);
    expect(report.results[0]).toMatchObject({ name: "GET /users/1", ok: true, status: { old: 200, new: 200 } });
  });

  test("status and selected header differences fail a case", async () => {
    const report = await verifyContracts({ cases: [c("GET", "/users/2"), c("GET", "/nope")], old: `http://127.0.0.1:${old.port}`, new: newApp });
    expect(report.results[0].ok).toBe(false);
    expect(report.results[0].diffs).toContainEqual({ path: "status", kind: "changed", old: 404, new: 200 });
    const r = report.results[1];
    expect(r.ok).toBe(false);
    expect(r.status).toEqual({ old: 404, new: 404 });
    expect(r.diffs.some((d) => d.path === "header:content-type")).toBe(true);
  });

  test("content-type parameters (charset) are not differences", async () => {
    const report = await verifyContracts({ cases: [c("GET", "/users/1")], old: `http://127.0.0.1:${old.port}`, new: newApp, ignore: ["$.createdAt"] });
    expect(report.results[0].diffs).toEqual([]);
  });

  test("requestHeaders are sent to both (e.g. a test login cookie); redacted values are not", async () => {
    const report = await verifyContracts({
      cases: [c("GET", "/users/1", { headers: { cookie: "[REDACTED]" } })],
      old: `http://127.0.0.1:${old.port}`,
      new: newApp,
      ignore: ["$.createdAt"],
      requestHeaders: { cookie: "s=1" },
    });
    expect(report.results[0].ok).toBe(true);
  });

  test("without `old`, compares against the recorded response", async () => {
    const report = await verifyContracts({
      cases: [c("GET", "/users/1", { status: 200, responseHeaders: { "content-type": "application/json" }, response: { id: 1, name: "Ann", createdAt: "x", auth: null } }), c("GET", "/orders", { status: 200, response: { total: 10.5, items: [] } })],
      new: newApp,
      ignore: ["$.createdAt"],
    });
    expect(report.results.map((r) => r.ok)).toEqual([true, false]);
    expect(report.results[1].diffs).toEqual([{ path: "$.items[0]", kind: "added", new: { sku: "a", updatedAt: 2 } }]);
  });

  test("accepts JSONL text and a fetch function", async () => {
    const jsonl = JSON.stringify(c("GET", "/users/1"));
    const report = await verifyContracts({ cases: jsonl, old: (req) => newApp.fetch(req), new: newApp });
    expect(report.passed).toBe(1);
  });

  test("an unreachable old app is a failed case with an error, not a crash", async () => {
    const report = await verifyContracts({ cases: [c("GET", "/users/1")], old: "http://127.0.0.1:1", new: newApp });
    expect(report.results[0].ok).toBe(false);
    expect(report.results[0].error).toContain("old");
  });

  test("formatReport prints a readable summary", async () => {
    const report = await verifyContracts({ cases: [c("GET", "/orders")], old: `http://127.0.0.1:${old.port}`, new: newApp, ignore: ["$..updatedAt"] });
    const text = formatReport(report);
    expect(text).toContain("FAIL GET /orders");
    expect(text).toContain('$.total: type "10.50" -> 10.5');
    expect(text).toContain("0 passed, 1 failed");
  });
});
