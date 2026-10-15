// Adversarial checks: what a JSON workflow (built in a browser) or a caller of the routes can reach.
import { describe, expect, test } from "bun:test";
import { definePlugin, t, type AuthUser } from "miujs";
import { blockedUrlReason, compileExpression, createHttpAction, defineWorkflow, fromJson, interpolate, parseDuration, validateSpec, webhook, type ActionDef } from "../src/index.ts";
import { templateExpressions } from "../src/expr.ts";
import { setup } from "./helpers.ts";

function recordingFetch(respond: (req: Request) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.url);
    return respond(req);
  }) as typeof fetch;
  return { calls, fetch: f };
}

async function runHttp(url: string, f: typeof fetch, actions: ActionDef[] = []) {
  const wf = fromJson({ name: "h", trigger: { type: "manual" }, steps: [{ id: "call", type: "action", action: "http", retries: 0, params: { url: "{{ input.url }}" } }] }, { actions });
  const s = setup([wf], { fetch: f });
  await s.ready();
  const { id } = await s.wf.start("h", { url });
  await s.mq.drain();
  return (await s.wf.getRun(id)).steps[0];
}

describe("security: http action SSRF", () => {
  const internal = [
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0.0.0.0/",
    "http://localhost:8080/admin",
    "http://LOCALHOST./",
    "http://api.localhost/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::7f00:1]/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[2002:7f00:1::]/",
  ];
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi"]) {
    test(`non-http scheme ${url} never reaches fetch`, async () => {
      const f = recordingFetch();
      const step = await runHttp(url, f.fetch, [createHttpAction({ allowPrivateNetwork: true })]);
      expect(f.calls).toEqual([]);
      expect(step.status).toBe("failed");
    });
  }
  test("blockedUrlReason refuses non-http schemes on its own", () => {
    expect(blockedUrlReason(new URL("file:///etc/passwd"))).toContain("scheme");
    expect(blockedUrlReason(new URL("https://api.example.com/"))).toBeNull();
    expect(blockedUrlReason(new URL("http://[2606:4700::1111]/"))).toBeNull();
    expect(blockedUrlReason(new URL("http://8.8.8.8/"))).toBeNull();
  });
  for (const url of internal) {
    test(`blocks ${url}`, async () => {
      const f = recordingFetch();
      const step = await runHttp(url, f.fetch);
      expect(f.calls).toEqual([]);
      expect(step).toMatchObject({ status: "failed", attempts: 1, error: { code: "MIU_E_WORKFLOW_HTTP_BLOCKED" } });
    });
  }

  test("public hosts still work", async () => {
    const f = recordingFetch();
    const step = await runHttp("https://api.example.com/x", f.fetch);
    expect(f.calls).toEqual(["https://api.example.com/x"]);
    expect(step).toMatchObject({ status: "completed", output: { status: 200, body: { ok: true } } });
  });

  test("a redirect to an internal host is not followed", async () => {
    const f = recordingFetch((req) => (req.url.startsWith("https://api.example.com") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }) : Response.json({ secret: 1 })));
    const step = await runHttp("https://api.example.com/r", f.fetch);
    expect(f.calls).toEqual(["https://api.example.com/r"]);
    expect(step).toMatchObject({ status: "failed", error: { code: "MIU_E_WORKFLOW_HTTP_BLOCKED" } });
  });

  test("public redirects are followed (re-checked each hop), with a hop limit", async () => {
    const f = recordingFetch((req) => (req.url.endsWith("/a") ? new Response(null, { status: 301, headers: { location: "/b" } }) : Response.json({ at: new URL(req.url).pathname })));
    const step = await runHttp("https://api.example.com/a", f.fetch);
    expect(f.calls).toEqual(["https://api.example.com/a", "https://api.example.com/b"]);
    expect(step).toMatchObject({ status: "completed", output: { body: { at: "/b" } } });
    const loop = recordingFetch(() => new Response(null, { status: 302, headers: { location: "https://api.example.com/again" } }));
    const looped = await runHttp("https://api.example.com/start", loop.fetch);
    expect(loop.calls.length).toBeLessThanOrEqual(6);
    expect(looped).toMatchObject({ status: "failed" });
  });

  test("createHttpAction({ allowPrivateNetwork }) opts in to internal hosts", async () => {
    const f = recordingFetch();
    const step = await runHttp("http://127.0.0.1:9000/x", f.fetch, [createHttpAction({ allowPrivateNetwork: true })]);
    expect(f.calls).toEqual(["http://127.0.0.1:9000/x"]);
    expect(step.status).toBe("completed");
  });

  test("responses larger than the limit fail the step instead of filling the journal", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const f = recordingFetch(() => new Response(big));
    const step = await runHttp("https://api.example.com/big", f.fetch);
    expect(step).toMatchObject({ status: "failed", error: { code: "MIU_E_WORKFLOW_HTTP_TOO_LARGE" } });
    const small = await runHttp("https://api.example.com/big", recordingFetch(() => new Response("x".repeat(2000))).fetch, [createHttpAction({ maxResponseBytes: 1000 })]);
    expect(small).toMatchObject({ status: "failed", error: { code: "MIU_E_WORKFLOW_HTTP_TOO_LARGE" } });
  });

  test("a hanging endpoint times out", async () => {
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const step = await runHttp("https://api.example.com/slow", hanging, [createHttpAction({ timeoutMs: 30 })]);
    expect(step).toMatchObject({ status: "failed", error: { code: "MIU_E_WORKFLOW_HTTP_TIMEOUT" } });
  });
});

describe("security: expressions and specs", () => {
  test("deep nesting is a MIU_E_WORKFLOW_EXPRESSION, not a stack overflow", () => {
    const deep = "(".repeat(20_000) + "1" + ")".repeat(20_000);
    let err: any;
    try {
      compileExpression(deep);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_WORKFLOW_EXPRESSION");
    let err2: any;
    try {
      compileExpression("!".repeat(50_000) + "true");
    } catch (e) {
      err2 = e;
    }
    expect(err2?.code).toBe("MIU_E_WORKFLOW_EXPRESSION");
    // short but deep: the depth limit, not the length limit
    for (const src of ["(".repeat(100) + "1" + ")".repeat(100), "!".repeat(200) + "true", "[".repeat(100) + "]".repeat(100)]) {
      let e: any;
      try {
        compileExpression(src);
      } catch (x) {
        e = x;
      }
      expect(e?.message).toContain("nested deeper");
    }
    expect(compileExpression("((!(data.a == 1)))").evaluate({ data: { a: 2 } })).toBe(true);
  });

  test("very long expressions are refused quickly", () => {
    const long = Array.from({ length: 20_000 }, () => "data.a == 1").join(" || ");
    const t0 = performance.now();
    let err: any;
    try {
      compileExpression(long);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_WORKFLOW_EXPRESSION");
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test("template scanning is linear (no ReDoS on unclosed {{ or many {{)", () => {
    const evil = ["{{" + " ".repeat(20_000), "{{".repeat(20_000), "{{ data.a " + " ".repeat(20_000) + "}", "x{{".repeat(10_000) + "}}"];
    for (const s of evil) {
      const t0 = performance.now();
      templateExpressions(s);
      validateSpec({ name: "x", trigger: { type: "manual" }, steps: [{ id: "a", type: "action", action: "log", params: { message: s } }] });
      try {
        interpolate(s, { data: { a: 1 }, input: {}, steps: {} });
      } catch {}
      expect(performance.now() - t0).toBeLessThan(250);
    }
    // behaviour kept
    expect(templateExpressions("a {{ data.x }} b {{input.y}}")).toEqual(["data.x", "input.y"]);
    expect(interpolate("{{ data.n }}", { data: { n: 5 }, input: {}, steps: {} })).toBe(5);
    expect(interpolate("n={{ data.n }}!", { data: { n: 5 }, input: {}, steps: {} })).toBe("n=5!");
    const r = validateSpec({ name: "x", trigger: { type: "manual" }, steps: [{ id: "a", type: "action", action: "log", params: { message: "hi {{ data.a" } }] });
    expect(r.ok).toBe(false);
  });

  test("prototype paths read nothing", () => {
    const scope = { data: { a: 1 }, input: {}, steps: {} };
    for (const src of ["data.__proto__", "data.constructor", "data.constructor.name", "data.toString", "steps.__proto__.polluted", "data.a.constructor"]) {
      expect(compileExpression(src).evaluate(scope)).toBeUndefined();
    }
    expect(compileExpression("'constructor' in data").evaluate(scope)).toBe(false);
  });

  test("interpolate keeps __proto__ keys as data and never swaps the result's prototype", () => {
    const params = JSON.parse('{"__proto__": {"isAdmin": true}, "name": "{{ data.n }}"}');
    const out = interpolate(params, { data: { n: "x" }, input: {}, steps: {} }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { isAdmin?: unknown }).isAdmin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out.name).toBe("x");
  });

  test("a deeply nested spec is reported, not thrown as a RangeError", () => {
    let steps: any[] = [{ id: "leaf", type: "wait", duration: "1s" }];
    for (let i = 0; i < 5000; i++) steps = [{ id: `c${i}`, type: "condition", if: "true", then: steps }];
    const r = validateSpec({ name: "deep", trigger: { type: "manual" }, steps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => /nest/i.test(i.message))).toBe(true);
  });

  test("a spec with too many steps is refused", () => {
    const steps = Array.from({ length: 5000 }, (_, i) => ({ id: `w${i}`, type: "wait", duration: "1s" }));
    const r = validateSpec({ name: "many", trigger: { type: "manual" }, steps });
    expect(r.ok).toBe(false);
  });

  test("absurd durations are rejected", () => {
    expect(() => parseDuration("99999999999999999999999d")).toThrow();
    expect(() => parseDuration(Number.MAX_VALUE)).toThrow();
    expect(parseDuration("365d")).toBe(365 * 86_400_000);
  });
});

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("security: webhooks", () => {
  test("webhook bodies over the limit are refused with 413", async () => {
    const open = defineWorkflow("open", { trigger: webhook("/hooks/open", { maxBodySize: 1024 }), run: async () => 1 });
    const s = setup([open]);
    const res = await s.app.request("/hooks/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "y".repeat(5000) }) });
    expect(res.status).toBe(413);
    expect(await s.wf.listRuns()).toEqual([]);
    const ok = await s.app.request("/hooks/open", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(ok.status).toBe(202);
  });

  test("the default webhook body limit is 1 MiB", async () => {
    const open = defineWorkflow("open2", { trigger: webhook("/hooks/open2"), run: async () => 1 });
    const s = setup([open]);
    const res = await s.app.request("/hooks/open2", { method: "POST", body: JSON.stringify({ x: "y".repeat(1024 * 1024 + 10) }) });
    expect(res.status).toBe(413);
  });

  test("tolerance: signatures cover a timestamp, and stale or missing timestamps are replays", async () => {
    const wf = defineWorkflow("signed", { trigger: webhook("/hooks/signed", { secret: "shh", tolerance: 300 }), run: async () => 1 });
    const s = setup([wf]);
    const body = "{}";
    const now = Math.floor(s.clock.now() / 1000);
    const post = async (ts: number | null, sig: string) =>
      s.app.request("/hooks/signed", { method: "POST", headers: { "x-signature": sig, ...(ts === null ? {} : { "x-signature-timestamp": String(ts) }) }, body });
    expect((await post(now, await sign("shh", `${now}.${body}`))).status).toBe(202);
    // body-only signature (no timestamp) is refused
    expect((await post(null, await sign("shh", body))).status).toBe(401);
    // a captured request replayed later than the tolerance
    const old = now - 3600;
    expect((await post(old, await sign("shh", `${old}.${body}`))).status).toBe(401);
    // timestamp swapped without re-signing
    expect((await post(now, await sign("shh", `${old}.${body}`))).status).toBe(401);
  });

  test("JSON specs can set a webhook tolerance", async () => {
    const wf = fromJson({ name: "j", trigger: { type: "webhook", path: "/hooks/j", secretEnv: "J_SECRET", tolerance: 60 }, steps: [{ id: "w", type: "wait", duration: "1s" }] });
    const tr = wf.triggers[0] as { tolerance?: number };
    expect(tr.tolerance).toBe(60);
  });
});

describe("security: tenant (org) scoping", () => {
  // access() style context: ctx.can/ctx.authorize evaluate the ORG role when an org is active.
  function orgAuth() {
    return definePlugin({
      name: "fake-access",
      onRequest(ctx) {
        const raw = ctx.headers.get("x-user");
        if (raw) ctx.user = JSON.parse(raw) as AuthUser;
        const org = ctx.headers.get("x-org-id");
        (ctx as any).org = org ? { id: org, role: "owner" } : null;
        (ctx as any).can = () => true;
        (ctx as any).authorize = () => undefined;
      },
    });
  }
  const greet = defineWorkflow("greet", { input: t.object({ orgId: t.string() }), run: async ({ input }) => input.orgId });
  const headers = (org?: string) => ({ "content-type": "application/json", "x-user": JSON.stringify({ id: "u1", roles: [] }), ...(org ? { "x-org-id": org } : {}) });

  test("org-scoped requests cannot read, drive or emit into app-global workflows", async () => {
    const s = setup([greet], {}, { plugins: [orgAuth()], mcp: true });
    await s.ready();
    const victim = await s.wf.start("greet", { orgId: "B" });
    const calls: [string, RequestInit][] = [
      ["/workflows", { headers: headers("A") }],
      ["/workflows/runs", { headers: headers("A") }],
      [`/workflows/runs/${victim.id}`, { headers: headers("A") }],
      [`/workflows/runs/${victim.id}/cancel`, { method: "POST", headers: headers("A") }],
      [`/workflows/runs/${victim.id}/retry`, { method: "POST", headers: headers("A") }],
      ["/workflows/events", { method: "POST", headers: headers("A"), body: JSON.stringify({ event: "x", data: { orgId: "B" } }) }],
      ["/workflows/greet/runs", { method: "POST", headers: headers("A"), body: JSON.stringify({ input: { orgId: "B" } }) }],
    ];
    for (const [path, init] of calls) {
      const res = await s.app.request(path, init);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      expect(((await res.json()) as any).error.code).toBe("MIU_E_WORKFLOWS_ORG_SCOPED");
    }
    // MCP tools too
    const mcp = await s.app.request("/mcp", { method: "POST", headers: headers("A"), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workflow_runs", arguments: {} } }) });
    expect(JSON.stringify(await mcp.json())).toContain("MIU_E_WORKFLOWS_ORG_SCOPED");
    // Without an active org (a platform operator), the permission check decides as before.
    expect((await s.app.request("/workflows/runs", { headers: headers() })).status).toBe(200);
  });
});
