import { expect, test } from "bun:test";
import worker, { MiuStoreObject } from "../../examples/cloudflare/full.ts";
import { fakeBatch, fakeD1, fakeDurableObjectNamespace, fakeKV, fakeMessage, fakeQueueProducer, fakeR2 } from "./fakes.ts";

test("examples/cloudflare/full.ts runs end to end on fake bindings", async () => {
  const env = {
    DB: fakeD1(),
    CACHE: fakeKV(),
    FILES: fakeR2(),
    JOBS: fakeQueueProducer(),
    MIU_STORE: fakeDurableObjectNamespace((s) => new MiuStoreObject(s, {})),
    SESSION_SECRET: "x".repeat(32),
  };
  const ctx = { waitUntil() {} };
  const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`http://w${path}`, init), env as never, ctx);

  const me = await call("/me");
  expect(await me.json()).toEqual({ visits: 1 });
  expect(me.headers.get("ratelimit-limit")).toBe("100");
  const cookie = me.headers.get("set-cookie")!.split(";")[0]!;
  expect(await (await call("/me", { headers: { cookie } })).json()).toEqual({ visits: 2 });

  const fd = new FormData();
  fd.append("file", new File(["png"], "a.png", { type: "image/png" }));
  const up = await call("/files", { method: "POST", body: fd });
  expect(up.status).toBe(201);
  const { key } = (await up.json()) as { key: string };
  expect(env.JOBS.sent).toHaveLength(1);

  const m = fakeMessage(env.JOBS.sent[0]!.body as never);
  await worker.queue!(fakeBatch([m]), env as never, ctx);
  expect(m.acked).toBe(true);
  expect(env.FILES.objects.has(`thumbs/${key}`)).toBe(true);
  expect(await (await call(`/files/${key}`)).text()).toBe("png");

  expect(await (await call("/stats")).json()).toEqual({ files: 2 });
  expect((await call("/stats")).headers.get("x-miu-cache")).toBe("HIT");

  const tools = await call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(tools.status).toBe(200);
});
