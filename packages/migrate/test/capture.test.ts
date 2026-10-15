import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { miu, route, t } from "miujs";
import { captureMiddleware, memorySink, parseCases, redact } from "../src/capture.ts";
import { migrateProxy } from "../src/proxy.ts";

let upstream: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/gzip") return new Response(Bun.gzipSync(JSON.stringify({ ok: true })), { headers: { "content-type": "application/json", "content-encoding": "gzip" } });
      if (url.pathname === "/big") return new Response("x".repeat(200_000), { headers: { "content-type": "text/plain" } });
      const body = req.method === "GET" ? null : await req.json();
      return Response.json({ id: 1, email: "ann@example.com", token: "abc", echo: body }, { status: 201, headers: { "set-cookie": "laravel_session=secret; Path=/", "x-old": "1" } });
    },
  });
});
afterAll(() => upstream.stop(true));

const local = route.get("/local/:id", { params: t.object({ id: t.string() }), handler: ({ params }) => ({ id: params.id, name: "Local" }) });

function makeApp(opts: Partial<Parameters<typeof captureMiddleware>[0]> = {}) {
  const sink = memorySink();
  const app = miu({
    logLevel: "silent",
    routes: [local],
    plugins: [captureMiddleware({ sink, ...opts }), migrateProxy({ upstream: `http://127.0.0.1:${upstream.port}` })],
  });
  return { app, sink };
}

describe("redact", () => {
  test("emails, tokens and secret-looking keys, deeply", () => {
    const out = redact({
      email: "x",
      contact: "write to ann@example.com today",
      password: "hunter2",
      nested: { api_key: "k", access_token: "t", list: [{ password_confirmation: "p", ok: 1 }] },
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      auth: "Bearer abc.def",
      id: 42,
      name: "Ann",
      ref: "ORDER-2024-0001",
    });
    expect(out).toEqual({
      email: "[REDACTED]",
      contact: "write to [EMAIL] today",
      password: "[REDACTED]",
      nested: { api_key: "[REDACTED]", access_token: "[REDACTED]", list: [{ password_confirmation: "[REDACTED]", ok: 1 }] },
      jwt: "[TOKEN]",
      auth: "[REDACTED]",
      id: 42,
      name: "Ann",
      ref: "ORDER-2024-0001",
    });
  });
  test("long random strings look like tokens", () => {
    expect(redact({ v: "Xb4cqf5fz1a2fT0Hr7m9Bq2vLx8Kp3Ws6Ye1Ud0N" })).toEqual({ v: "[TOKEN]" });
    expect(redact({ v: "a".repeat(50) })).toEqual({ v: "a".repeat(50) });
  });
  test("configurable keys", () => {
    expect(redact({ ssn_last4: "1234", phone: "555" }, { keys: ["phone"] })).toEqual({ ssn_last4: "[REDACTED]", phone: "[REDACTED]" });
  });
});

describe("captureMiddleware", () => {
  test("records proxied exchanges as redacted entries", async () => {
    const { app, sink } = makeApp();
    const res = await app.request("/users?email=bob@example.com&page=2", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token", cookie: "laravel_session=secret", accept: "application/json" },
      body: JSON.stringify({ name: "Bob", password: "hunter2" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).token).toBe("abc"); // the client still gets the real response
    await app.drain();
    expect(sink.entries).toHaveLength(1);
    const e = sink.entries[0];
    expect(e).toMatchObject({ v: 1, method: "POST", path: "/users", query: { email: "[REDACTED]", page: "2" }, status: 201, servedBy: "proxy", route: null });
    expect(e.headers).toEqual({ "content-type": "application/json", accept: "application/json", authorization: "[REDACTED]", cookie: "[REDACTED]" });
    expect(e.body).toEqual({ name: "Bob", password: "[REDACTED]" });
    expect(e.response).toEqual({ id: 1, email: "[REDACTED]", token: "[REDACTED]", echo: { name: "Bob", password: "[REDACTED]" } });
    expect(e.responseHeaders["set-cookie"]).toBe("[REDACTED]");
    expect(e.responseHeaders["content-type"]).toContain("application/json");
    const line = sink.jsonl();
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("bob@example.com");
  });

  test("records MiuJS-served routes too, with the route name", async () => {
    const { app, sink } = makeApp();
    await app.request("/local/9");
    await app.drain();
    expect(sink.entries[0]).toMatchObject({ method: "GET", path: "/local/9", servedBy: "miujs", route: "get_local_by_id", status: 200, response: { id: "9", name: "Local" } });
  });

  test("only: 'proxied' skips MiuJS routes", async () => {
    const { app, sink } = makeApp({ only: "proxied" });
    await app.request("/local/9");
    await app.drain();
    expect(sink.entries).toHaveLength(0);
  });

  test("sample: 0 records nothing, a function decides per request", async () => {
    const none = makeApp({ sample: 0 });
    await none.app.request("/a");
    await none.app.drain();
    expect(none.sink.entries).toHaveLength(0);
    const some = makeApp({ sample: (ctx) => ctx.path === "/b" });
    await some.app.request("/a");
    await some.app.request("/b");
    await some.app.drain();
    expect(some.sink.entries.map((e) => e.path)).toEqual(["/b"]);
  });

  test("decodes gzip responses for the record", async () => {
    const { app, sink } = makeApp();
    await (await app.request("/gzip")).arrayBuffer();
    await app.drain();
    expect(sink.entries[0].response).toEqual({ ok: true });
  });

  test("large bodies are truncated, not buffered whole", async () => {
    const { app, sink } = makeApp({ maxBodyBytes: 1000 });
    expect((await (await app.request("/big")).text()).length).toBe(200_000);
    await app.drain();
    expect(sink.entries[0].response).toBeNull();
    expect(sink.entries[0].responseOmitted).toBe("too large");
  });

  test("a failing sink never breaks the request", async () => {
    const app = miu({ logLevel: "silent", routes: [local], plugins: [captureMiddleware({ sink: { write() { throw new Error("disk full"); } } })] });
    expect((await app.request("/local/1")).status).toBe(200);
    await app.drain();
  });

  test("parseCases reads JSONL back and reports bad lines", () => {
    const { sink } = makeApp();
    sink.write({ v: 1, ts: "x", method: "GET", path: "/a", query: {}, headers: {}, body: null, status: 200, responseHeaders: {}, response: {}, durationMs: 1, servedBy: "proxy", route: null });
    expect(parseCases(sink.jsonl() + "\n\n")).toHaveLength(1);
    expect(() => parseCases('{"method":"GET","path":"/a"}\nnot json')).toThrow(expect.objectContaining({ code: "MIU_E_MIGRATE_CASES" }));
  });
});
