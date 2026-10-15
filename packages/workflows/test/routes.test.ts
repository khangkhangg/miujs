import { describe, expect, test } from "bun:test";
import { definePlugin, route, t, type AuthUser } from "miujs";
import { defineWorkflow, manual, on, webhook } from "../src/index.ts";
import { setup, T0 } from "./helpers.ts";

/** Signs users in from an `x-user` JSON header; optionally adds a structural ctx.authorize. */
function fakeAuth(opts: { authorize?: boolean } = {}) {
  return definePlugin({
    name: "fake-auth",
    onRequest(ctx) {
      const raw = ctx.headers.get("x-user");
      if (raw) ctx.user = JSON.parse(raw) as AuthUser;
      if (opts.authorize) (ctx as any).authorize = (perm: string) => ((ctx.user?.perms as string[] | undefined) ?? []).includes(perm);
    },
  });
}

const as = (user: Partial<AuthUser> & { perms?: string[] }) => ({ "x-user": JSON.stringify({ id: "u1", roles: [], ...user }) });
const admin = as({ id: "admin", roles: ["admin"] });
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const greet = defineWorkflow("greet", {
  description: "Say hi",
  trigger: [on("contact.created"), manual()],
  input: t.object({ name: t.string() }),
  run: async ({ input, step }) => await step.run("hi", () => `hi ${input.name}`),
});

const dealApproval = defineWorkflow("deal-approval", {
  trigger: on("deal.updated", { match: { "data.stage": "won" } }),
  input: t.object({ id: t.string(), amount: t.number(), stage: t.string() }),
  run: async ({ input, step }) => {
    if (input.amount <= 10_000) return { approved: true, auto: true };
    const d = await step.waitForApproval("manager-approval", { approvers: { role: "manager" }, timeout: "2d" });
    return { approved: d?.decision === "approve", by: d?.by.id ?? null, comment: d?.comment ?? null };
  },
});

function make(o: { authorize?: boolean } = {}) {
  return setup([greet, dealApproval], {}, { plugins: [fakeAuth(o)] });
}

describe("routes: auth", () => {
  test("signed-out callers get 401", async () => {
    const { app } = make();
    const res = await app.request("/workflows");
    expect(res.status).toBe(401);
  });

  test("without ctx.authorize, the admin role is required", async () => {
    const { app } = make();
    expect((await app.request("/workflows", { headers: as({ roles: ["sales"] }) })).status).toBe(403);
    expect((await app.request("/workflows", { headers: admin })).status).toBe(200);
  });

  test("with ctx.authorize, its permission decides (admin role alone is not enough)", async () => {
    const { app } = make({ authorize: true });
    expect((await app.request("/workflows", { headers: as({ roles: ["admin"] }) })).status).toBe(403);
    expect((await app.request("/workflows", { headers: as({ perms: ["workflows:read"] }) })).status).toBe(200);
    const start = await app.request("/workflows/greet/runs", json({ input: { name: "a" } }, as({ perms: ["workflows:read"] })));
    expect(start.status).toBe(403);
    expect((await app.request("/workflows/greet/runs", json({ input: { name: "a" } }, as({ perms: ["workflows:run"] })))).status).toBe(201);
  });
});

describe("routes: workflows and runs", () => {
  test("GET /workflows lists definitions with triggers and input schema", async () => {
    const { app } = make();
    const body = (await (await app.request("/workflows", { headers: admin })).json()) as any;
    expect(body.workflows[0]).toEqual({
      name: "greet",
      description: "Say hi",
      triggers: [{ type: "event", event: "contact.created" }, { type: "manual" }],
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    });
    expect(body.workflows.map((w: any) => w.name)).toEqual(["greet", "deal-approval"]);
  });

  test("POST /workflows/:name/runs starts a run; GET /workflows/runs/:id shows the timeline", async () => {
    const { app, mq } = make();
    const res = await app.request("/workflows/greet/runs", json({ input: { name: "Ann" } }, admin));
    expect(res.status).toBe(201);
    const { id, status } = (await res.json()) as any;
    expect(status).toBe("queued");
    await mq.drain();
    const run = (await (await app.request(`/workflows/runs/${id}`, { headers: admin })).json()) as any;
    expect(run).toMatchObject({ id, workflow: "greet", status: "completed", output: "hi Ann", trigger: { type: "manual", by: "admin" } });
    expect(run.steps).toEqual([expect.objectContaining({ name: "hi", kind: "run", status: "completed", attempts: 1, output: "hi Ann" })]);
    expect(run).not.toHaveProperty("token");
    expect(run).not.toHaveProperty("leaseUntil");
  });

  test("bad input is a 400 with the issues; unknown workflow a 404; unknown run a 404", async () => {
    const { app } = make();
    const bad = await app.request("/workflows/greet/runs", json({ input: { name: 1 } }, admin));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("MIU_E_VALIDATION");
    const unknown = await app.request("/workflows/nope/runs", json({}, admin));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error.code).toBe("MIU_E_WORKFLOW_UNKNOWN");
    expect((await app.request("/workflows/runs/nope", { headers: admin })).status).toBe(404);
  });

  test("GET /workflows/runs filters and pages", async () => {
    const { app, mq, clock, wf } = make();
    await wf.start("greet", { name: "a" });
    clock.advance(1000);
    await wf.start("greet", { name: "b" });
    clock.advance(1000);
    await wf.start("deal-approval", { id: "d", amount: 1, stage: "won" });
    await mq.drain();
    const list = async (qs: string) => (await (await app.request(`/workflows/runs${qs}`, { headers: admin })).json()) as any;
    const all = await list("");
    expect(all.runs.map((r: any) => r.workflow)).toEqual(["deal-approval", "greet", "greet"]);
    expect(Object.keys(all.runs[0]).sort()).toEqual(["createdAt", "error", "finishedAt", "id", "status", "trigger", "updatedAt", "wakeAt", "workflow"]);
    expect((await list("?workflow=greet")).runs.length).toBe(2);
    expect((await list("?status=failed")).runs.length).toBe(0);
    const page = await list("?limit=2");
    expect(page.runs.length).toBe(2);
    expect(page.next).toBe(T0 + 1000);
    const rest = await list(`?limit=2&before=${page.next}`);
    expect(rest.runs.map((r: any) => r.createdAt)).toEqual([T0]);
    expect(rest.next).toBeNull();
    expect((await app.request("/workflows/runs?status=bogus", { headers: admin })).status).toBe(400);
  });

  test("cancel and retry", async () => {
    let fail = true;
    const flaky = defineWorkflow("flaky", {
      run: async ({ step }) =>
        await step.run("x", () => {
          if (fail) throw new Error("down");
          return 1;
        }, { retries: 0 }),
    });
    const waits = defineWorkflow("waits", { run: async ({ step }) => await step.waitForEvent("e", { event: "never" }) });
    const s = setup([flaky, waits], {}, { plugins: [fakeAuth()] });
    await s.ready();
    const a = await s.wf.start("flaky");
    const b = await s.wf.start("waits");
    await s.mq.drain();
    const cancel = await s.app.request(`/workflows/runs/${b.id}/cancel`, { method: "POST", headers: admin });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as any).status).toBe("cancelled");
    expect((await s.app.request(`/workflows/runs/${b.id}/cancel`, { method: "POST", headers: admin })).status).toBe(409);
    fail = false;
    const retry = await s.app.request(`/workflows/runs/${a.id}/retry`, { method: "POST", headers: admin });
    expect(retry.status).toBe(200);
    await s.mq.drain();
    expect((await s.wf.getRun(a.id)).status).toBe("completed");
  });
});

describe("routes: events", () => {
  test("POST /workflows/events emits; the idempotency key de-duplicates", async () => {
    const { app, mq } = make();
    const res = await app.request("/workflows/events", json({ event: "contact.created", data: { name: "Bo" }, idempotencyKey: "k" }, admin));
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.started.map((x: any) => x.workflow)).toEqual(["greet"]);
    const again = (await (await app.request("/workflows/events", json({ event: "contact.created", data: { name: "Bo" }, idempotencyKey: "k" }, admin))).json()) as any;
    expect(again.duplicate).toBe(true);
    await mq.drain();
  });

  test("ctx.events.emit works from any route", async () => {
    const createContact = route.post("/contacts", {
      body: t.object({ name: t.string() }),
      handler: async ({ body, events }) => {
        const r = await events.emit("contact.created", body);
        return { started: r.started.length };
      },
    });
    const s = setup([greet], {}, { routes: [createContact] });
    const res = await s.app.call(createContact, { body: { name: "Cy" } });
    expect(res.body).toEqual({ started: 1 });
    await s.mq.drain();
    expect((await s.wf.listRuns({ status: "completed" })).length).toBe(1);
  });

  test("the approval event name is reserved", async () => {
    const { app } = make();
    const res = await app.request("/workflows/events", json({ event: "workflow.approval", data: {} }, admin));
    expect(res.status).toBe(400);
  });
});

describe("approvals", () => {
  test("an approver's decision resumes the run", async () => {
    const { app, mq, wf } = make();
    const emitted = await wf.emit("deal.updated", { id: "d1", amount: 50_000, stage: "won" });
    const id = emitted.started[0].id;
    let tries = 0;
    while ((await wf.getRun(id)).status !== "waiting" && tries++ < 50) await new Promise((r) => setTimeout(r, 0));
    const run = (await (await app.request(`/workflows/runs/${id}`, { headers: admin })).json()) as any;
    expect(run.status).toBe("waiting");
    expect(run.steps[0]).toMatchObject({ name: "manager-approval", kind: "approval", status: "waiting", waitingFor: { approvers: { role: ["manager"] }, expiresAt: T0 + 2 * 86_400_000 } });

    const url = `/workflows/approvals/${id}/manager-approval`;
    expect((await app.request(url, json({ decision: "approve" }))).status).toBe(401);
    const denied = await app.request(url, json({ decision: "approve" }, as({ id: "s1", roles: ["sales"] })));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error.code).toBe("MIU_E_WORKFLOW_NOT_APPROVER");
    expect((await app.request(url, json({ decision: "maybe" }, as({ id: "m1", roles: ["manager"] })))).status).toBe(400);

    const ok = await app.request(url, json({ decision: "approve", comment: "go" }, as({ id: "m1", roles: ["manager"] })));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ runId: id, step: "manager-approval", decision: "approve" });
    // Decided once: a second decision finds nothing pending.
    const twice = await app.request(url, json({ decision: "reject" }, as({ id: "m2", roles: ["manager"] })));
    expect(twice.status).toBe(404);
    expect(((await twice.json()) as any).error.code).toBe("MIU_E_WORKFLOW_APPROVAL_NOT_PENDING");
    await mq.drain();
    expect((await wf.getRun(id)).output).toEqual({ approved: true, by: "m1", comment: "go" });
  });

  test("emitting the approval event cannot approve; a timeout resumes with null", async () => {
    const { mq, wf, settle } = make();
    const id = (await wf.emit("deal.updated", { id: "d1", amount: 50_000, stage: "won" })).started[0].id;
    await settle();
    expect((await wf.getRun(id)).status).toBe("waiting");
    await expect(wf.emit("workflow.approval", { runId: id, step: "manager-approval", decision: "approve" })).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_EVENT_RESERVED", status: 400 });
    await settle();
    expect((await wf.getRun(id)).status).toBe("waiting");
    await mq.drain(); // runs through to the 2-day timeout
    expect((await wf.getRun(id)).output).toEqual({ approved: false, by: null, comment: null });
  });

  test("approvers can be listed by user id", async () => {
    const byUser = defineWorkflow("by-user", { run: async ({ step }) => (await step.waitForApproval("ok", { approvers: { users: ["boss"] } }))?.decision });
    const s = setup([byUser], {}, { plugins: [fakeAuth()] });
    await s.ready();
    const { id } = await s.wf.start("by-user");
    await s.settle();
    const res = await s.app.request(`/workflows/approvals/${id}/ok`, json({ decision: "reject" }, as({ id: "boss" })));
    expect(res.status).toBe(200);
    await s.mq.drain();
    expect((await s.wf.getRun(id)).output).toBe("reject");
  });
});

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("webhooks", () => {
  const form = defineWorkflow("form", {
    trigger: webhook("/hooks/form", { secret: (env) => env.FORM_SECRET as string, header: "x-hub-signature-256" }),
    input: t.object({ email: t.string() }),
    run: async ({ input }) => input.email,
  });
  const open = defineWorkflow("open", {
    trigger: webhook("/hooks/open", { input: (body: any) => ({ email: body.contact.email }) }),
    input: t.object({ email: t.string() }),
    run: async ({ input }) => input.email,
  });

  test("a correctly signed request starts the workflow", async () => {
    const s = setup([form]);
    const env = { FORM_SECRET: "shh" };
    const body = JSON.stringify({ email: "a@b.c" });
    const res = await hook(s.app, "/hooks/form", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await sign("shh", body)}` }, body }, env);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as any;
    await s.mq.drain();
    expect(await s.wf.getRun(id)).toMatchObject({ status: "completed", output: "a@b.c", trigger: { type: "webhook", path: "/hooks/form" } });
  });

  test("missing or wrong signatures are rejected with 401", async () => {
    const s = setup([form]);
    const env = { FORM_SECRET: "shh" };
    const body = JSON.stringify({ email: "a@b.c" });
    const none = await hook(s.app, "/hooks/form", { method: "POST", headers: { "content-type": "application/json" }, body }, env);
    expect(none.status).toBe(401);
    expect(((await none.json()) as any).error.code).toBe("MIU_E_WORKFLOW_SIGNATURE");
    const wrong = await hook(s.app, "/hooks/form", { method: "POST", headers: { "x-hub-signature-256": await sign("other", body) }, body }, env);
    expect(wrong.status).toBe(401);
    expect(await s.wf.listRuns()).toEqual([]);
  });

  test("a configured secret that is missing from env fails closed", async () => {
    const s = setup([form]);
    const env = {};
    const body = "{}";
    const res = await hook(s.app, "/hooks/form", { method: "POST", headers: { "x-hub-signature-256": await sign("anything", body) }, body }, env);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.code).toBe("MIU_E_WORKFLOW_CONFIG");
  });

  test("unsigned webhooks map the body to input; bad JSON or input is a 400", async () => {
    const s = setup([open]);
    const res = await s.app.request("/hooks/open", json({ contact: { email: "x@y.z" } }));
    expect(res.status).toBe(202);
    await s.mq.drain();
    expect((await s.wf.listRuns())[0].output).toBe("x@y.z");
    expect((await s.app.request("/hooks/open", { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await s.app.request("/hooks/open", json({ contact: {} }))).status).toBe(400);
  });
});

/** POST through the full pipeline with an explicit request env (how Workers pass bindings and secrets). */
function hook(app: { dispatch(req: Request, env: unknown, p: { runtime: "bun" }): Response | Promise<Response> }, path: string, init: RequestInit, env: Record<string, unknown>) {
  return app.dispatch(new Request(`http://localhost${path}`, init), env, { runtime: "bun" });
}
