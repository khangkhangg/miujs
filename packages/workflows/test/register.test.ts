import { describe, expect, test } from "bun:test";
import { miu, route, t } from "miujs";
import { cloudflareQueue } from "@miujs/queue";
import { cron, defineWorkflow, manual, on, webhook, workflows } from "../src/index.ts";
import { setup, T0 } from "./helpers.ts";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("register / unregister", () => {
  test("event and manual workflows registered after start run; unregistered ones stop", async () => {
    const s = setup([]);
    await s.ready();
    const greet = defineWorkflow("greet", { trigger: [on("contact.created"), manual()], run: async ({ input }) => input });
    s.wf.register(greet);
    expect((await s.wf.emit("contact.created", { n: 1 })).started.map((x) => x.workflow)).toEqual(["greet"]);
    expect((await s.wf.start("greet", {})).status).toBe("queued");
    expect(s.wf.unregister("greet")).toBe(true);
    expect(s.wf.unregister("greet")).toBe(false);
    expect((await s.wf.emit("contact.created", { n: 2 })).started).toEqual([]);
    await expect(s.wf.start("greet", {})).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_UNKNOWN" });
    s.wf.stop();
  });

  test("names and webhook paths must be unique", async () => {
    const s = setup([defineWorkflow("a", { trigger: webhook("/hooks/a"), run: async () => null })]);
    await s.ready();
    expect(() => s.wf.register(defineWorkflow("a", { trigger: manual(), run: async () => null }))).toThrow(/a/);
    expect(() => s.wf.register(defineWorkflow("b", { trigger: webhook("/hooks/a"), run: async () => null }))).toThrow(/\/hooks\/a/);
    expect(() => s.wf.register({} as never)).toThrow();
    s.wf.stop();
  });

  test("a cron workflow registered after start runs on schedule (fake clock); unregistering stops it", async () => {
    const s = setup([]);
    await s.ready();
    s.wf.register(defineWorkflow("weekly", { trigger: cron("0 9 * * 1"), run: async ({ step }) => await step.now() }));
    s.clock.advance(60 * 60_000); // Monday 09:00
    await s.mq.drain();
    const runs = await s.wf.listRuns({});
    expect(runs.map((r) => [r.workflow, r.status, r.trigger])).toEqual([["weekly", "completed", { type: "cron", cron: "0 9 * * 1" }]]);
    expect(runs[0].output).toBe(T0 + 3_600_000);
    s.wf.unregister("weekly");
    s.clock.advance(7 * 86_400_000);
    await s.mq.drain();
    expect((await s.wf.listRuns({})).length).toBe(1);
    s.wf.stop();
  });

  test("a webhook workflow registered after start answers signed POSTs; unregistering frees the path", async () => {
    const s = setup([]);
    await s.ready();
    s.wf.register(
      defineWorkflow("form", {
        trigger: webhook("/hooks/form", { secret: "shh" }),
        input: t.object({ email: t.string() }),
        run: async ({ input }) => input.email,
      }),
    );
    const body = JSON.stringify({ email: "a@b.c" });
    expect((await s.app.request("/hooks/form", { method: "POST", body })).status).toBe(401);
    const ok = await s.app.request("/hooks/form", { method: "POST", headers: { "x-signature": `sha256=${await sign("shh", body)}` }, body });
    expect(ok.status).toBe(202);
    const { id } = (await ok.json()) as { id: string };
    await s.mq.drain();
    expect(await s.wf.getRun(id)).toMatchObject({ status: "completed", output: "a@b.c", trigger: { type: "webhook", path: "/hooks/form" } });
    const info = s.app.inspect().plugins.find((p) => p.name === "workflows")!.info as { routes: string[] };
    expect(info.routes).toContain("POST /hooks/form");
    s.wf.unregister("form");
    expect((await s.app.request("/hooks/form", { method: "POST", headers: { "x-signature": await sign("shh", body) }, body })).status).toBe(404);
    s.wf.stop();
  });

  test("the webhook dispatcher leaves other routes and 404/405 answers alone", async () => {
    const ping = route.get("/ping", { handler: () => "pong" });
    const s = setup([defineWorkflow("h", { trigger: webhook("/hooks/h"), run: async () => null })], {}, { routes: [ping] });
    expect((await s.app.request("/ping")).status).toBe(200);
    expect((await s.app.request("/ping", { method: "POST" })).status).toBe(405);
    expect((await s.app.request("/nothing", { method: "POST" })).status).toBe(404);
    expect((await s.app.request("/hooks/h", { method: "GET" })).status).toBe(404);
    expect((await s.app.request("/hooks/h", post({}))).status).toBe(202);
    s.wf.stop();
  });
});

describe("unknown workflows: on-demand resolution", () => {
  test("a webhook for an unknown path asks onUnknown once, then dispatches if it got registered", async () => {
    const s = setup([]);
    await s.ready();
    const asked: unknown[] = [];
    s.wf.onUnknown(async (what) => {
      asked.push(what);
      if ("webhook" in what && what.webhook === "/hooks/late") s.wf.register(defineWorkflow("late", { trigger: webhook("/hooks/late"), run: async () => "ok" }));
    });
    expect((await s.app.request("/hooks/late", post({}))).status).toBe(202);
    expect((await s.app.request("/hooks/nope", post({}))).status).toBe(404);
    expect(asked).toEqual([{ webhook: "/hooks/late" }, { webhook: "/hooks/nope" }]);
    s.wf.stop();
  });

  test("starting or resuming an unknown workflow asks onUnknown with its name", async () => {
    const s = setup([]);
    await s.ready();
    const asked: unknown[] = [];
    s.wf.onUnknown(async (what) => {
      asked.push(what);
      if ("workflow" in what && what.workflow === "lazy") s.wf.register(defineWorkflow("lazy", { trigger: manual(), run: async () => 1 }));
    });
    const r = await s.wf.start("lazy", {});
    await s.mq.drain();
    expect((await s.wf.getRun(r.id)).status).toBe("completed");
    expect(asked).toEqual([{ workflow: "lazy" }]);
    s.wf.stop();
  });
});

describe("Cloudflare Workers cron triggers", () => {
  const fakeQueue = () => {
    const sent: any[] = [];
    return { sent, binding: { send: async (body: unknown) => void sent.push(body), sendBatch: async () => {} } };
  };

  test("registered cron workflows are dispatched by the scheduled handler; `crons` declares the triggers", async () => {
    const wf = workflows({ workflows: [], adapter: cloudflareQueue({ binding: "WQ" }), crons: ["0 9 * * 1", "*/5 * * * *"] });
    const app = miu({ logLevel: "silent", plugins: [wf] });
    await app.ready();
    expect(wf.cloudflare().crons).toEqual(["0 9 * * 1", "*/5 * * * *"]);
    wf.register(defineWorkflow("weekly", { trigger: cron("0 9 * * 1"), run: async () => null }));
    const q = fakeQueue();
    await app.scheduled({ cron: "0 9 * * 1" }, { WQ: q.binding }, {});
    expect(q.sent.map((m) => m.input)).toEqual([{ workflow: "weekly", cron: "0 9 * * 1" }]);
    wf.unregister("weekly");
    await app.scheduled({ cron: "0 9 * * 1" }, { WQ: q.binding }, {});
    expect(q.sent.length).toBe(1);
  });

  test("a cron event no schedule matches asks onUnknown first (another isolate may have published it)", async () => {
    const wf = workflows({ workflows: [], adapter: cloudflareQueue({ binding: "WQ" }), crons: ["*/5 * * * *"] });
    const app = miu({ logLevel: "silent", plugins: [wf] });
    await app.ready();
    const asked: unknown[] = [];
    wf.onUnknown(async (what) => {
      asked.push(what);
      wf.register(defineWorkflow("often", { trigger: cron("*/5 * * * *"), run: async () => null }));
    });
    const q = fakeQueue();
    await app.scheduled({ cron: "*/5 * * * *" }, { WQ: q.binding }, {});
    expect(asked).toEqual([{ cron: "*/5 * * * *" }]);
    expect(q.sent.map((m) => m.input)).toEqual([{ workflow: "often", cron: "*/5 * * * *" }]);
  });
});
