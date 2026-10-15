import { describe, expect, test } from "bun:test";
import { miu, t } from "miujs";
import { cloudflareQueue } from "@miujs/queue";
import { createCloudflareWorkflow, defineWorkflow, workflows, type CfWorkflowStep } from "../src/index.ts";

/** In-test fake of Cloudflare's WorkflowStep: journals `do` results by name like the real one. */
function fakeStep(events: Record<string, { payload: unknown }[]> = {}) {
  const journal = new Map<string, unknown>();
  const calls: { kind: string; name: string; arg?: unknown }[] = [];
  const step = {
    journal,
    calls,
    async do(name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) {
      const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => Promise<unknown>;
      calls.push({ kind: "do", name, arg: typeof configOrFn === "function" ? undefined : configOrFn });
      if (journal.has(name)) return journal.get(name);
      const v = await fn();
      journal.set(name, v);
      return v;
    },
    async sleep(name: string, duration: unknown) {
      calls.push({ kind: "sleep", name, arg: duration });
    },
    async sleepUntil(name: string, until: unknown) {
      calls.push({ kind: "sleepUntil", name, arg: until });
    },
    async waitForEvent(name: string, opts: { type: string; timeout?: unknown }) {
      calls.push({ kind: "waitForEvent", name, arg: opts });
      const next = events[opts.type]?.shift();
      if (!next) throw new Error("Workflow timed out waiting for event");
      return { ...next, type: opts.type, timestamp: new Date(1000) };
    },
  };
  return step as typeof step & CfWorkflowStep;
}

/** Stand-in for `WorkflowEntrypoint` from "cloudflare:workers". */
class FakeEntrypoint {
  ctx: unknown;
  env: Record<string, unknown>;
  constructor(ctx: unknown, env: Record<string, unknown>) {
    this.ctx = ctx;
    this.env = env;
  }
}

const followUp = defineWorkflow("contact-follow-up", {
  input: t.object({ contactId: t.string() }),
  run: async ({ input, step, env }) => {
    const c = await step.run("enrich", async () => ({ score: 42, key: env.API_KEY }), { retries: 2, backoff: 10 });
    await step.sleep("wait-a-day", "1d");
    const reply = await step.waitForEvent<{ contactId: string }>("reply", { event: "email_replied", match: { "data.contactId": input.contactId }, timeout: "3d" });
    const at = await step.now();
    const sent = reply ? null : await step.run("send-follow-up", () => "sent");
    return { score: c.score, key: c.key, reply: reply?.data ?? null, sent, at };
  },
});

describe("createCloudflareWorkflow", () => {
  test("maps steps onto step.do / step.sleep / step.waitForEvent", async () => {
    const Cls = createCloudflareWorkflow(followUp, { base: FakeEntrypoint });
    const inst = new Cls({}, { API_KEY: "k" });
    expect(inst).toBeInstanceOf(FakeEntrypoint);
    const step = fakeStep({ email_replied: [{ payload: { contactId: "other" } }, { payload: { contactId: "c1" } }] });
    const out = await inst.run({ payload: { contactId: "c1" }, timestamp: new Date(0), instanceId: "i1" }, step);
    expect(out).toMatchObject({ score: 42, key: "k", reply: { contactId: "c1" }, sent: null });
    expect(step.calls[0]).toEqual({ kind: "do", name: "enrich", arg: { retries: { limit: 2, delay: 10_000, backoff: "constant" } } });
    expect(step.calls[1]).toEqual({ kind: "sleep", name: "wait-a-day", arg: 86_400_000 });
    // The non-matching event is skipped; the next wait gets a suffixed name.
    expect(step.calls.filter((c) => c.kind === "waitForEvent").map((c) => [c.name, (c.arg as any).type])).toEqual([
      ["reply", "email_replied"],
      ["reply#1", "email_replied"],
    ]);
  });

  test("a timeout resolves waitForEvent with null; replays reuse journaled results", async () => {
    let enriched = 0;
    const wf = defineWorkflow("w", {
      run: async ({ step }) => {
        await step.run("enrich", () => ++enriched);
        const e = await step.waitForEvent("reply", { event: "x", timeout: "1h" });
        return { e, id: await step.uuid() };
      },
    });
    const Cls = createCloudflareWorkflow(wf, { base: FakeEntrypoint });
    const step = fakeStep();
    const a = await new Cls({}, {}).run({ payload: {}, timestamp: new Date(0), instanceId: "i" }, step);
    const b = await new Cls({}, {}).run({ payload: {}, timestamp: new Date(0), instanceId: "i" }, step);
    expect(a.e).toBeNull();
    expect(a).toEqual(b);
    expect(enriched).toBe(1);
    expect(step.calls.find((c) => c.kind === "waitForEvent")!.arg).toEqual({ type: "x", timeout: 3_600_000 });
  });

  test("invalid payloads and duplicate step names fail with MiuJS errors", async () => {
    const Cls = createCloudflareWorkflow(followUp, { base: FakeEntrypoint });
    await expect(new Cls({}, {}).run({ payload: { nope: 1 }, timestamp: new Date(0), instanceId: "i" }, fakeStep())).rejects.toMatchObject({ code: "MIU_E_VALIDATION" });
    const dup = defineWorkflow("dup", {
      run: async ({ step }) => {
        await step.run("a", () => 1);
        await step.run("a", () => 2);
      },
    });
    const D = createCloudflareWorkflow(dup, { base: FakeEntrypoint });
    await expect(new D({}, {}).run({ payload: {}, timestamp: new Date(0), instanceId: "i" }, fakeStep())).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_STEP_DUPLICATE" });
  });

  test("works without a base class (plain WorkflowEntrypoint shape)", async () => {
    const Cls = createCloudflareWorkflow(defineWorkflow("p", { run: async ({ step }) => await step.run("x", () => 1) }));
    const inst = new Cls({ waitUntil() {} }, { A: 1 });
    expect(inst.env).toEqual({ A: 1 });
    expect(await inst.run({ payload: {}, timestamp: new Date(0), instanceId: "i" }, fakeStep())).toBe(1);
  });
});

describe("queue engine on Workers (no Workflows binding)", () => {
  test("cloudflareQueue: delays are capped at 12h and chained", async () => {
    const sent: { body: any; options?: { delaySeconds?: number } }[] = [];
    const WORKFLOWS_QUEUE = { send: async (body: unknown, options?: { delaySeconds?: number }) => void sent.push({ body: structuredClone(body), options }) };
    const wf = defineWorkflow("nap", { run: async ({ step }) => void (await step.sleep("nap", "1d")) });
    const plugin = workflows({ workflows: [wf], adapter: cloudflareQueue({ binding: "WORKFLOWS_QUEUE" }) });
    const app = miu({ plugins: [plugin], logLevel: "silent" });
    await app.ready();
    const env = { WORKFLOWS_QUEUE };
    const { id } = await plugin.start("nap", {}, { env });
    const deliver = async () => {
      const m = sent.shift()!;
      await app.queue({ queue: "q", messages: [{ id: "m", body: m.body, attempts: 1, ack() {}, retry() {} }] }, env, {});
      return m;
    };
    expect((await deliver()).options).toBeUndefined();
    expect(sent[0].options).toEqual({ delaySeconds: 43_200 });
    expect((await plugin.getRun(id, env)).status).toBe("sleeping");
    expect(plugin.inspect().queue).toEqual({ adapter: "cloudflare", maxDelaySeconds: 43_200 });
    expect(plugin.cloudflare()).toMatchObject({ queues: { producers: ["WORKFLOWS_QUEUE"], consumers: ["WORKFLOWS_QUEUE"] } });
  });
});
