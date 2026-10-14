import { afterAll, describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { formatDiffs, recordContract, verifyContract, type Contract } from "../../src/migrate/contract.ts";

let counter = 0;
const legacy = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const common = { "x-request-id": String(++counter), date: new Date().toUTCString() };
    if (url.pathname === "/api/users/1")
      return Response.json(
        { id: 1, name: "Ann", roles: ["admin", "dev"], profile: { city: "Hanoi" }, created_at: new Date().toISOString() },
        { headers: { ...common, "set-cookie": "s=1" } },
      );
    if (url.pathname === "/api/users" && req.method === "POST") {
      const body = (await req.json()) as { name: string };
      return Response.json({ id: 2, name: body.name }, { status: 201, headers: { ...common, location: "/api/users/2" } });
    }
    if (url.pathname === "/health") return new Response("OK", { headers: { "content-type": "text/plain;charset=UTF-8" } });
    if (url.pathname === "/empty") return new Response(null, { status: 204 });
    return new Response("Not Found", { status: 404 });
  },
});
const TARGET = `http://localhost:${legacy.port}`;
afterAll(() => legacy.stop(true));

const REQUESTS = [
  { method: "GET", path: "/api/users/1" },
  { method: "POST", path: "/api/users", body: { name: "Bo" } },
  { path: "/health" },
  { path: "/empty" },
];

async function record(): Promise<Contract> {
  return recordContract({ target: TARGET, requests: REQUESTS });
}

function port(opts: { name?: string; city?: string; status?: number; roles?: string[] } = {}) {
  const app = new Miu({ logger: false });
  app.get("/api/users/:id", (c) => {
    c.header("x-request-id", "zzz");
    return { id: 1, name: opts.name ?? "Ann", roles: opts.roles ?? ["admin", "dev"], profile: { city: opts.city ?? "Hanoi" }, created_at: "2020-01-01T00:00:00Z" };
  });
  app.post("/api/users", async (c) => {
    const body = (await c.req.json()) as { name: string };
    return c.json({ id: 2, name: body.name }, opts.status ?? 201, { location: "/api/users/2" });
  });
  app.get("/health", () => "OK");
  app.get("/empty", () => undefined);
  return app;
}

describe("recordContract", () => {
  test("records JSON-serializable interactions without volatile headers", async () => {
    const contract = await record();
    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    expect(contract.interactions).toHaveLength(4);
    const first = contract.interactions[0]!;
    expect(first.request).toEqual({ method: "GET", path: "/api/users/1" });
    expect(first.response.status).toBe(200);
    expect(first.response.body).toMatchObject({ id: 1, name: "Ann" });
    expect(first.response.headers["content-type"]).toContain("application/json");
    for (const h of ["date", "set-cookie", "x-request-id", "content-length"]) expect(first.response.headers[h]).toBeUndefined();
    expect(contract.interactions[1]!.response).toMatchObject({ status: 201, body: { id: 2, name: "Bo" } });
    expect(contract.interactions[2]!.response.body).toBe("OK");
    expect(contract.interactions[3]!.response).toMatchObject({ status: 204, body: null });
  });

  test("ignoreFields strips timestamps at record time", async () => {
    const c = await recordContract({ target: TARGET, requests: [REQUESTS[0]!], ignoreFields: ["created_at"] });
    expect(c.interactions[0]!.response.body).not.toHaveProperty("created_at");
  });
});

describe("verifyContract", () => {
  test("a faithful port has no diffs (timestamps ignored, content-type compared by media type)", async () => {
    const diffs = await verifyContract(port(), await record(), { ignoreFields: ["created_at"] });
    expect(diffs).toEqual([]);
  });

  test("without ignoring timestamps the volatile field shows up", async () => {
    const diffs = await verifyContract(port(), await record());
    expect(diffs.map((d) => d.path)).toEqual(["body.created_at"]);
  });

  test("reports status, nested JSON paths, array items and text body diffs", async () => {
    const contract = await record();
    const diffs = await verifyContract(port({ name: "Anne", city: "Hue", status: 200, roles: ["admin"] }), contract, { ignoreFields: ["created_at"] });
    const byPath = Object.fromEntries(diffs.map((d) => [`${d.request} ${d.path}`, d]));
    expect(byPath["GET /api/users/1 body.name"]).toMatchObject({ expected: "Ann", actual: "Anne" });
    expect(byPath["GET /api/users/1 body.profile.city"]).toMatchObject({ expected: "Hanoi", actual: "Hue" });
    expect(byPath["GET /api/users/1 body.roles[1]"]).toMatchObject({ expected: "dev", actual: undefined });
    expect(byPath["POST /api/users status"]).toMatchObject({ expected: 201, actual: 200 });
    expect(formatDiffs(diffs)).toContain("GET /api/users/1 body.name: expected \"Ann\", got \"Anne\"");
  });

  test("detects header and text differences; ignoreHeaders and normalize", async () => {
    const contract = await record();
    const app = port();
    app.post("/api/users", (c) => c.json({ id: 2, name: "Bo" }, 201, { location: "/users/2" }));
    const diffs = await verifyContract(app, contract, { ignoreFields: ["created_at"] });
    expect(diffs.map((d) => d.path)).toEqual(["header.location"]);
    expect(await verifyContract(app, contract, { ignoreFields: ["created_at"], ignoreHeaders: ["location"] })).toEqual([]);

    const t = new Miu({ logger: false });
    t.get("/health", () => "ok");
    const only = { ...contract, interactions: [contract.interactions[2]!] };
    expect((await verifyContract(t, only)).map((d) => d.path)).toEqual(["body"]);
    expect(await verifyContract(t, only, { normalize: (b) => (typeof b === "string" ? b.toLowerCase() : b) })).toEqual([]);
  });
});
