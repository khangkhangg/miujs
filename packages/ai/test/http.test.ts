import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { parseSSE, send } from "../src/http.ts";
import { collect, fakeFetch, json, runtime, sse } from "./helpers.ts";

const KEY = "sk-secret-123";
const call = (rt: ReturnType<typeof runtime>) => send(rt, "anthropic", "https://api.test/v1/x", { method: "POST", body: "{}" }, KEY);

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isMiuError(e)) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("send()", () => {
  test("returns the response when it is ok", async () => {
    const rt = runtime({ fetch: fakeFetch(json({ ok: 1 })) });
    expect(await (await call(rt)).json()).toEqual({ ok: 1 });
  });

  test("retries 429 honoring retry-after seconds", async () => {
    const f = fakeFetch(json({}, 429, { "retry-after": "2" }), json({ ok: 1 }));
    const rt = runtime({ fetch: f });
    expect((await call(rt)).status).toBe(200);
    expect(f.calls.length).toBe(2);
    expect(rt.sleeps).toEqual([2000]);
  });

  test("retry-after may be an HTTP date", async () => {
    const at = new Date(Date.now() + 3000).toUTCString();
    const f = fakeFetch(json({}, 429, { "retry-after": at }), json({ ok: 1 }));
    const rt = runtime({ fetch: f });
    await call(rt);
    expect(rt.sleeps[0]).toBeGreaterThan(1000);
    expect(rt.sleeps[0]).toBeLessThanOrEqual(3000);
  });

  test("retries 5xx and 529 with growing backoff", async () => {
    const f = fakeFetch(json({}, 500), json({}, 529), json({ ok: 1 }));
    const rt = runtime({ fetch: f });
    expect((await call(rt)).status).toBe(200);
    expect(rt.sleeps.length).toBe(2);
    expect(rt.sleeps[1]).toBeGreaterThan(rt.sleeps[0]);
  });

  test("gives up on 429 after the retries with MIU_E_AI_RATE_LIMITED", async () => {
    const f = fakeFetch(json({ error: { message: "slow down" } }, 429, { "retry-after": "1" }));
    const e = await caught(call(runtime({ fetch: f, retries: 2 })));
    expect(f.calls.length).toBe(3);
    expect(e.code).toBe("MIU_E_AI_RATE_LIMITED");
    expect(e.status).toBe(429);
    expect(e.details).toMatchObject({ provider: "anthropic", retryAfter: 1 });
    expect(e.fix).toBeTruthy();
  });

  test("does not sleep for a retry-after longer than the cap", async () => {
    const f = fakeFetch(json({}, 429, { "retry-after": "3600" }));
    const rt = runtime({ fetch: f });
    const e = await caught(call(rt));
    expect(e.code).toBe("MIU_E_AI_RATE_LIMITED");
    expect(f.calls.length).toBe(1);
    expect(rt.sleeps).toEqual([]);
  });

  test("gives up on 5xx with MIU_E_AI_PROVIDER_ERROR", async () => {
    const e = await caught(call(runtime({ fetch: fakeFetch(json({}, 503)), retries: 1 })));
    expect(e.code).toBe("MIU_E_AI_PROVIDER_ERROR");
    expect(e.status).toBe(502);
  });

  test("401 fails fast with MIU_E_AI_AUTH", async () => {
    const f = fakeFetch(json({ error: { message: "invalid x-api-key" } }, 401));
    const e = await caught(call(runtime({ fetch: f })));
    expect(f.calls.length).toBe(1);
    expect(e.code).toBe("MIU_E_AI_AUTH");
  });

  test("400 reports the provider message with the key redacted", async () => {
    const f = fakeFetch(json({ error: { type: "invalid_request_error", message: `bad key ${KEY} in request` } }, 400));
    const e = await caught(call(runtime({ fetch: f })));
    expect(e.code).toBe("MIU_E_AI_BAD_REQUEST");
    expect(e.message).toContain("bad key");
    expect(JSON.stringify(e.toJSON())).not.toContain(KEY);
    expect(e.message).not.toContain(KEY);
  });

  test("network errors are retried", async () => {
    let n = 0;
    const flaky = (async () => {
      if (n++ === 0) throw new TypeError("connection reset");
      return json({ ok: 1 });
    }) as unknown as typeof fetch;
    expect((await call(runtime({ fetch: flaky }))).status).toBe(200);
  });

  test("times out with MIU_E_AI_TIMEOUT", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const e = await caught(call(runtime({ fetch: hang, timeoutMs: 20, retries: 0 })));
    expect(e.code).toBe("MIU_E_AI_TIMEOUT");
  });
});

describe("parseSSE()", () => {
  test("parses events split across chunks, ignoring comments", async () => {
    const res = sse([
      ["message_start", { a: 1 }],
      [null, { b: "x\ny" }],
      [null, "[DONE]"],
    ]);
    const events = await collect(parseSSE(res.body!));
    expect(events).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { event: "message", data: '{"b":"x\\ny"}' },
      { event: "message", data: "[DONE]" },
    ]);
  });
});
