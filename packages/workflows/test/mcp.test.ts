import { describe, expect, test } from "bun:test";
import { definePlugin, t, type AuthUser } from "miujs";
import { defineWorkflow, on } from "../src/index.ts";
import { setup } from "./helpers.ts";

const greet = defineWorkflow("greet", {
  description: "Say hi",
  trigger: on("contact.created"),
  input: t.object({ name: t.string() }),
  run: async ({ input, step }) => await step.run("hi", () => `hi ${input.name}`),
});

const userFromHeader = definePlugin({
  name: "fake-auth",
  onRequest(ctx) {
    const raw = ctx.headers.get("x-user");
    if (raw) ctx.user = JSON.parse(raw) as AuthUser;
  },
});

function make() {
  const s = setup([greet], {}, { mcp: true, plugins: [userFromHeader] });
  let n = 0;
  const call = async (name: string, args: Record<string, unknown> = {}, user: Partial<AuthUser> | null = { id: "a", roles: ["admin"] }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) headers["x-user"] = JSON.stringify(user);
    const res = await s.app.request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
    const body = (await res.json()) as any;
    return body.result as { isError: boolean; content: { text: string }[]; structuredContent?: any };
  };
  return { ...s, call };
}

describe("MCP tools", () => {
  test("are listed with input schemas", async () => {
    const { app } = make();
    const res = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const tools = ((await res.json()) as any).result.tools as { name: string; inputSchema: any; description: string }[];
    const names = tools.map((x) => x.name);
    for (const n of ["workflows_list", "workflow_start", "workflow_runs", "workflow_run", "emit_event"]) expect(names).toContain(n);
    const start = tools.find((x) => x.name === "workflow_start")!;
    expect(start.inputSchema.required).toEqual(["workflow"]);
    expect(start.inputSchema.properties.workflow.enum).toEqual(["greet"]);
    expect(start.description.length).toBeGreaterThan(20);
    // The REST routes are not duplicated as tools.
    expect(names.filter((x) => /workflow/i.test(x)).sort()).toEqual(["workflow_run", "workflow_runs", "workflow_start", "workflows_list"]);
  });

  test("an agent can list, start, inspect runs and emit events", async () => {
    const { call, mq } = make();
    const list = await call("workflows_list");
    expect(list.isError).toBe(false);
    expect(list.structuredContent.workflows[0]).toMatchObject({ name: "greet", triggers: [{ type: "event", event: "contact.created" }] });

    const started = await call("workflow_start", { workflow: "greet", input: { name: "Ann" } });
    expect(started.structuredContent.status).toBe("queued");
    const id = started.structuredContent.id;
    await mq.drain();

    const run = await call("workflow_run", { id });
    expect(run.structuredContent).toMatchObject({ id, status: "completed", output: "hi Ann", trigger: { type: "manual", by: "a" } });
    expect(run.structuredContent.steps[0].name).toBe("hi");

    const emitted = await call("emit_event", { event: "contact.created", data: { name: "Bo" }, idempotencyKey: "x" });
    expect(emitted.structuredContent.started.length).toBe(1);
    await mq.drain();

    const runs = await call("workflow_runs", { workflow: "greet", status: "completed", limit: 10 });
    expect(runs.structuredContent.runs.length).toBe(2);
    expect(runs.structuredContent.runs[0]).not.toHaveProperty("output");
  });

  test("errors carry the code and fix; permissions are enforced", async () => {
    const { call } = make();
    const bad = await call("workflow_start", { workflow: "greet", input: { name: 1 } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("MIU_E_VALIDATION");
    expect(bad.content[0].text).toContain("Fix:");
    const missing = await call("workflow_run", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("id");
    const anon = await call("workflows_list", {}, null);
    expect(anon.isError).toBe(true);
    expect(anon.content[0].text).toContain("MIU_E_UNAUTHORIZED");
    const sales = await call("workflows_list", {}, { id: "s", roles: ["sales"] });
    expect(sales.content[0].text).toContain("MIU_E_FORBIDDEN");
  });
});
