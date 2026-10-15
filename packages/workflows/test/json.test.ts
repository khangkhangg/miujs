import { describe, expect, test } from "bun:test";
import { t } from "miujs";
import { defineAction, fromJson, validateSpec, type SpecIssue } from "../src/index.ts";
import { setup, T0 } from "./helpers.ts";

const updates: unknown[] = [];
const updateRecord = defineAction("update_record", {
  description: "Update a CRM record",
  params: t.object({ id: t.string(), fields: t.record(t.unknown()) }),
  run: async (params) => {
    updates.push(params);
    return { updated: params.id };
  },
});

function issuesOf(spec: unknown): SpecIssue[] {
  const r = validateSpec(spec, { actions: [updateRecord] });
  if (r.ok) throw new Error("expected issues");
  return r.issues;
}
const at = (issues: SpecIssue[], path: string) => issues.find((i) => i.path === path);

const dealFlow = {
  name: "deal-flow",
  description: "Approve big won deals",
  trigger: { type: "event", event: "deal.updated" },
  steps: [
    {
      id: "check",
      type: "condition",
      if: "data.amount > 10000 && data.stage == 'won'",
      then: [
        { id: "approve", type: "approval", approvers: { role: "manager" }, timeout: "2d" },
        {
          id: "notify",
          type: "condition",
          if: "steps.approve.output.decision == 'approve'",
          then: [{ id: "email", type: "action", action: "send_email", params: { to: "{{ data.owner }}", subject: "Deal {{ data.id }} approved", text: "Amount: {{ data.amount }}" } }],
        },
      ],
      else: [{ id: "small", type: "action", action: "log", params: { message: "small deal {{ data.id }}" } }],
    },
    { id: "record", type: "action", action: "update_record", params: { id: "{{ data.id }}", fields: { amount: "{{ data.amount }}", approved: "{{ steps.approve.output.decision == 'approve' }}" } } },
  ],
};

describe("validateSpec: precise errors", () => {
  test("a good spec is valid", () => {
    expect(validateSpec(dealFlow, { actions: [updateRecord] })).toMatchObject({ ok: true });
  });

  test("top level", () => {
    expect(issuesOf(null)[0]).toMatchObject({ path: "", message: expect.stringContaining("object") });
    const issues = issuesOf({ trigger: { type: "nope" }, steps: [] });
    expect(at(issues, "name")).toMatchObject({ message: "is required", fix: expect.stringContaining('"name"') });
    expect(at(issues, "trigger.type")!.fix).toContain("event");
    expect(at(issues, "steps")!.message).toContain("at least 1");
  });

  test("triggers", () => {
    expect(at(issuesOf({ name: "x", trigger: { type: "cron", cron: "61 * * * *" }, steps: [{ id: "a", type: "wait", duration: "1d" }] }), "trigger.cron")!.message).toContain("minute");
    expect(at(issuesOf({ name: "x", trigger: { type: "event" }, steps: [{ id: "a", type: "wait", duration: "1d" }] }), "trigger.event")).toBeDefined();
    expect(at(issuesOf({ name: "x", trigger: { type: "webhook", path: "hooks" }, steps: [{ id: "a", type: "wait", duration: "1d" }] }), "trigger.path")!.fix).toContain("/");
  });

  test("steps: actions, params, keys, ids, expressions, durations — with nested paths", () => {
    const issues = issuesOf({
      name: "bad",
      trigger: { type: "manual" },
      steps: [
        { id: "a", type: "action", action: "send_sms", params: {} },
        { id: "b", type: "action", action: "send_email", parms: {} },
        { id: "c", type: "action", action: "send_email", params: { to: "x@y.z", text: "{{ steps.nope.output }}" } },
        { id: "d", type: "condition", if: "data.amount >", then: [{ id: "e", type: "wait", duration: "soon" }] },
        { id: "a", type: "wait_for_event", event: "x", match: { "data.id": "{{ input.id" }, timeout: "1d" },
        { id: "f", type: "approval", approvers: {} },
        { id: "g", type: "dance" },
        { id: "h", type: "action", action: "update_record", params: { id: 5, fields: {} } },
        { id: "i", type: "condition", if: "data.x == eval('1')", then: [] },
      ],
    });
    // First: every issue explains the fix (later toMatchObject calls with matchers mutate in Bun).
    for (const i of issues) expect(typeof i.fix === "string" && i.fix.length > 5).toBe(true);
    expect(at(issues, "steps.0.action")).toMatchObject({ message: expect.stringContaining("send_sms"), fix: expect.stringContaining("defineAction") });
    expect(at(issues, "steps.1.parms")).toMatchObject({ message: "is not a known key", fix: expect.stringContaining('"params"') });
    expect(at(issues, "steps.2.params.subject")).toMatchObject({ message: "is required" });
    expect(at(issues, "steps.2.params.text")!.message).toContain('unknown step "nope"');
    expect(at(issues, "steps.3.if")!.message).toContain("Unexpected end");
    expect(at(issues, "steps.3.then.0.duration")!.fix).toContain('"1d"');
    expect(at(issues, "steps.4.id")!.message).toContain('duplicate id "a" (first at steps.0)');
    expect(at(issues, "steps.4.match.data.id")).toBeDefined();
    expect(at(issues, "steps.5.approvers")!.fix).toContain("role");
    expect(at(issues, "steps.6.type")!.fix).toContain("wait_for_event");
    expect(at(issues, "steps.7.params.id")!.message).toContain("expected string");
    expect(at(issues, "steps.8.if")!.message).toContain('Unknown name "eval"');
  });

  test("templated params skip type checks that only apply after interpolation", () => {
    const r = validateSpec(
      { name: "x", trigger: { type: "manual" }, steps: [{ id: "a", type: "action", action: "update_record", params: { id: "{{ input.id }}", fields: "{{ input.fields }}" } }] },
      { actions: [updateRecord] },
    );
    expect(r.ok).toBe(true);
  });

  test("fromJson throws MIU_E_WORKFLOW_SPEC_INVALID with the issues", () => {
    let err: any;
    try {
      fromJson({ name: "x", trigger: { type: "manual" }, steps: [{ id: "a", type: "action", action: "nope" }] });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("MIU_E_WORKFLOW_SPEC_INVALID");
    expect(err.message).toContain("steps.0.action");
    expect(err.fix).toContain("defineAction");
    expect(err.details.issues[0].path).toBe("steps.0.action");
  });
});

describe("fromJson: definitions", () => {
  test("maps triggers and keeps the spec", () => {
    const ev = fromJson({ name: "e", trigger: { type: "event", event: "a.b", match: { "data.x": 1 } }, steps: [{ id: "w", type: "wait", duration: "1m" }] });
    expect(ev.triggers).toEqual([{ type: "event", event: "a.b", match: { "data.x": 1 } }]);
    expect(ev.spec).toMatchObject({ name: "e" });
    expect(fromJson({ name: "c", trigger: { type: "cron", cron: "0 9 * * 1" }, steps: [{ id: "w", type: "wait", duration: "1m" }] }).triggers[0]).toMatchObject({ type: "cron", cron: "0 9 * * 1" });
    const hook = fromJson({ name: "h", trigger: { type: "webhook", path: "/hooks/h", secretEnv: "H_SECRET" }, steps: [{ id: "w", type: "wait", duration: "1m" }] });
    const tr = hook.triggers[0] as any;
    expect(tr.path).toBe("/hooks/h");
    expect(tr.secret({ H_SECRET: "s" })).toBe("s");
    expect(fromJson({ name: "m", trigger: { type: "manual" }, steps: [{ id: "w", type: "wait", duration: "1m" }] }).triggers).toEqual([{ type: "manual" }]);
  });

  test("defineAction validates its config", () => {
    expect(() => defineAction("", { params: t.object({}), run: async () => null })).toThrow(expect.objectContaining({ code: "MIU_E_WORKFLOW_CONFIG" }));
    expect(() => defineAction("x", { params: {} as any, run: async () => null })).toThrow(expect.objectContaining({ code: "MIU_E_WORKFLOW_CONFIG" }));
  });
});

describe("fromJson: execution", () => {
  function make(fetchImpl?: typeof fetch) {
    const sent: any[] = [];
    const wf = fromJson(dealFlow, { actions: [updateRecord] });
    const s = setup([wf], { mailer: { send: async (m) => void sent.push(m) }, fetch: fetchImpl });
    return { ...s, sent };
  }

  test("big won deal: approval, email, record update with typed interpolation", async () => {
    updates.length = 0;
    const s = make();
    await s.ready();
    const res = await s.wf.emit("deal.updated", { id: "d1", amount: 50_000, stage: "won", owner: "o@x.io" });
    const id = res.started[0].id;
    await s.settle();
    expect((await s.wf.getRun(id)).status).toBe("waiting");
    await s.wf.decide(id, "approve", { id: "m1", roles: ["manager"] }, "approve");
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(s.sent).toEqual([{ to: "o@x.io", subject: "Deal d1 approved", text: "Amount: 50000" }]);
    expect(updates).toEqual([{ id: "d1", fields: { amount: 50_000, approved: true } }]);
    expect(run.steps.map((x) => x.name)).toEqual(["approve", "email", "record"]);
    expect((run.output as any).steps.record.output).toEqual({ updated: "d1" });
  });

  test("small deal takes the else branch and logs", async () => {
    updates.length = 0;
    const s = make();
    await s.ready();
    const id = (await s.wf.emit("deal.updated", { id: "d2", amount: 5, stage: "won" })).started[0].id;
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.steps.map((x) => x.name)).toEqual(["small", "record"]);
    expect(s.sent).toEqual([]);
    expect(updates).toEqual([{ id: "d2", fields: { amount: 5, approved: false } }]);
  });

  test("send_email without a mailer fails the step with MIU_E_WORKFLOW_MAILER_MISSING, no retries", async () => {
    const wf = fromJson({ name: "m", trigger: { type: "manual" }, steps: [{ id: "e", type: "action", action: "send_email", params: { to: "a@b.c", subject: "s", text: "t" } }] });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start("m", {});
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("failed");
    expect(run.steps[0]).toMatchObject({ status: "failed", attempts: 1, error: { code: "MIU_E_WORKFLOW_MAILER_MISSING" } });
  });

  test("params that are invalid after interpolation fail without retries", async () => {
    const wf = fromJson({ name: "p", trigger: { type: "manual" }, steps: [{ id: "u", type: "action", action: "update_record", params: { id: "{{ input.n }}", fields: {} } }] }, { actions: [updateRecord] });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start("p", { n: 5 });
    await s.mq.drain();
    expect((await s.wf.getRun(id)).steps[0]).toMatchObject({ status: "failed", attempts: 1, error: { code: "MIU_E_VALIDATION" } });
  });

  test("http action: injected fetch, retries 5xx, returns status and parsed body", async () => {
    const calls: Request[] = [];
    let n = 0;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      if (++n === 1) return new Response("busy", { status: 503 });
      return Response.json({ ok: true, n });
    }) as typeof fetch;
    const wf = fromJson({
      name: "h",
      trigger: { type: "manual" },
      steps: [{ id: "call", type: "action", action: "http", params: { url: "https://api.example.com/x/{{ input.id }}", method: "POST", headers: { "x-k": "v" }, body: { id: "{{ input.id }}" } } }],
    });
    const s = setup([wf], { fetch: fakeFetch });
    await s.ready();
    const { id } = await s.wf.start("h", { id: "c1" });
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.steps[0]).toMatchObject({ attempts: 2, output: { status: 200, body: { ok: true, n: 2 } } });
    expect(calls[1].url).toBe("https://api.example.com/x/c1");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].headers.get("x-k")).toBe("v");
    expect(calls[1].headers.get("content-type")).toBe("application/json");
    expect(await calls[1].json()).toEqual({ id: "c1" });
  });

  test("http action: 4xx fails at once", async () => {
    let n = 0;
    const fakeFetch = (async () => (n++, new Response("no", { status: 404 }))) as unknown as typeof fetch;
    const wf = fromJson({ name: "h4", trigger: { type: "manual" }, steps: [{ id: "call", type: "action", action: "http", params: { url: "https://api.example.com/" } }] });
    const s = setup([wf], { fetch: fakeFetch });
    await s.ready();
    const { id } = await s.wf.start("h4", {});
    await s.mq.drain();
    expect(n).toBe(1);
    expect((await s.wf.getRun(id)).steps[0]).toMatchObject({ status: "failed", error: { message: expect.stringContaining("404") } });
  });

  test("wait and wait_for_event with a templated match", async () => {
    const wf = fromJson({
      name: "follow",
      trigger: { type: "event", event: "contact.created" },
      steps: [
        { id: "pause", type: "wait", duration: "1d" },
        { id: "reply", type: "wait_for_event", event: "email.replied", match: { "data.contactId": "{{ data.contactId }}" }, timeout: "3d" },
        { id: "branch", type: "condition", if: "steps.reply.output == null", then: [{ id: "nudge", type: "action", action: "log", params: { message: "nudge {{ data.contactId }}" } }] },
      ],
    });
    const s = setup([wf]);
    await s.ready();
    const id = (await s.wf.emit("contact.created", { contactId: "c9" })).started[0].id;
    await s.settle();
    expect((await s.wf.getRun(id)).status).toBe("sleeping");
    s.clock.advance(86_400_000);
    await s.settle();
    expect((await s.wf.getRun(id)).status).toBe("waiting");
    expect((await s.wf.emit("email.replied", { contactId: "c9" })).resumed).toEqual([id]);
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.steps.map((x) => x.name)).toEqual(["pause", "reply"]);
    expect(run.finishedAt).toBe(T0 + 86_400_000);
  });

  test("JSON workflows show up in inspect", async () => {
    const s = setup([fromJson(dealFlow, { actions: [updateRecord] })]);
    await s.ready();
    const info = s.app.inspect().plugins.find((p) => p.name === "workflows")!.info as any;
    expect(info.workflows[0]).toMatchObject({ name: "deal-flow", json: true, triggers: [{ type: "event", event: "deal.updated" }] });
    expect(info.actions).toEqual(expect.arrayContaining(["http", "send_email", "log"]));
  });
});
