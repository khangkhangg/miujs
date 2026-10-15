import { describe, expect, test } from "bun:test";
import { definePlugin, t, type App } from "miujs";
import { defineAction, defineWorkflow, fromJson, on, type WorkflowsService } from "../src/index.ts";
import { setup } from "./helpers.ts";

const greeterPlugin = definePlugin({
  name: "greeter",
  setup(app: App) {
    app.provide("greeter", { greet: (n: string) => `hi ${n}` });
  },
});

describe("app.service('workflows')", () => {
  test("is provided with start/emit/getRun/listRuns/cancel/retry/decide", async () => {
    const seen: unknown[] = [];
    const wf = defineWorkflow("echo", { trigger: on("thing.created"), run: ({ input }) => void seen.push(input) });
    const s = setup([wf]);
    await s.ready();
    const svc = s.app.service<WorkflowsService>("workflows");
    for (const k of ["start", "emit", "getRun", "listRuns", "cancel", "retry", "decide"] as const) expect(typeof svc[k]).toBe("function");
    const r = await svc.emit("thing.created", { id: 1 });
    expect(r.started).toHaveLength(1);
    await s.settle();
    expect(seen).toEqual([{ id: 1 }]);
    expect((await svc.listRuns({ workflow: "echo" })).map((x) => x.status)).toEqual(["completed"]);
  });
});

describe("service access from runs and actions", () => {
  test("ctx.service in code workflows and actx.service in JSON actions", async () => {
    const out: string[] = [];
    const code = defineWorkflow("code", { trigger: on("go"), run: ({ service }) => void out.push(service<{ greet(n: string): string }>("greeter").greet("code")) });
    const greet = defineAction("greet", {
      params: t.object({ name: t.string() }),
      run: (p, actx) => {
        out.push(actx.service<{ greet(n: string): string }>("greeter").greet(p.name));
        return null;
      },
    });
    const json = fromJson({ name: "json", trigger: { type: "event", event: "go" }, steps: [{ id: "g", type: "action", action: "greet", params: { name: "{{ data.who }}" } }] }, { actions: [greet] });
    const s = setup([code, json], {}, { plugins: [greeterPlugin] });
    await s.ready();
    await s.app.service<WorkflowsService>("workflows").emit("go", { who: "json" });
    await s.settle();
    expect(out.sort()).toEqual(["hi code", "hi json"]);
  });

  test("an unknown service fails the step with MIU_E_SERVICE_MISSING", async () => {
    const wf = defineWorkflow("bad", { trigger: on("go"), run: ({ service }) => void service("nope") });
    const s = setup([wf]);
    await s.ready();
    await s.wf.emit("go", {});
    await s.settle();
    const [run] = await s.wf.listRuns({ workflow: "bad" });
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("MIU_E_SERVICE_MISSING");
  });
});
