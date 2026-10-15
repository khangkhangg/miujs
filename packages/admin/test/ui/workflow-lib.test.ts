import { describe, expect, test } from "bun:test";
import { compileExpression, validateSpec, type WorkflowSpec } from "@miujs/workflows";
import { exprLib } from "../../src/ui/client/expr.ts";
import { workflowLib } from "../../src/ui/client/workflow.ts";

const ex = exprLib();
const wf = workflowLib();

describe("expression builder", () => {
  test("builds the safe expression syntax from rows", () => {
    expect(ex.build([{ left: "data.record.stage", op: "==", value: "won" }], "&&")).toBe("data.record.stage == 'won'");
    expect(ex.build([{ left: "data.record.amount", op: ">", value: "10000", kind: "number" }, { left: "data.record.vip", op: "==", value: "true", kind: "boolean" }], "&&")).toBe(
      "data.record.amount > 10000 && data.record.vip == true",
    );
    expect(ex.build([{ left: "data.record.stage", op: "in", value: "won, lost" }], "||")).toBe("data.record.stage in ['won', 'lost']");
    expect(ex.build([{ left: "data.record.tags", op: "contains", value: "vip" }], "&&")).toBe("'vip' in data.record.tags");
    expect(ex.build([{ left: "data.record.email", op: "empty", value: "" }, { left: "data.record.phone", op: "notEmpty", value: "" }], "||")).toBe("data.record.email == null || data.record.phone != null");
    expect(ex.build([{ left: "data.record.stage", op: "changed", value: "" }], "&&")).toBe("'stage' in data.changes");
  });

  test("quotes strings so they cannot break out of the literal", () => {
    const src = ex.build([{ left: "data.record.name", op: "==", value: "O'Neil \\ ' || true" }], "&&");
    expect(src).toBe("data.record.name == 'O\\'Neil \\\\ \\' || true'");
    const c = compileExpression(src);
    expect(c.evaluate({ data: { record: { name: "O'Neil \\ ' || true" } } })).toBe(true);
    expect(c.evaluate({ data: { record: { name: "x" } } })).toBe(false);
  });

  test("refuses paths outside data/input/steps and bad numbers", () => {
    expect(() => ex.build([{ left: "constructor.x", op: "==", value: "1" }], "&&")).toThrow(/path/);
    expect(() => ex.build([{ left: "data.x) || (true", op: "==", value: "1" }], "&&")).toThrow(/path/);
    expect(() => ex.build([{ left: "data.x", op: ">", value: "1e9; x", kind: "number" }], "&&")).toThrow(/number/);
    expect(() => ex.build([{ left: "data.x", op: "eval", value: "1" }], "&&")).toThrow(/operator/);
  });

  test("everything it builds compiles and evaluates as intended", () => {
    const rows = [
      { left: "data.record.amount", op: ">=", value: "100", kind: "number" as const },
      { left: "data.record.stage", op: "in", value: "won,lost" },
      { left: "data.record.tags", op: "contains", value: "vip" },
      { left: "data.record.stage", op: "changed", value: "" },
    ];
    const src = ex.build(rows, "&&");
    const scope = { data: { record: { amount: 100, stage: "won", tags: ["vip"] }, changes: { stage: { before: "lead" } } } };
    expect(compileExpression(src).evaluate(scope)).toBe(true);
    expect(compileExpression(src).evaluate({ data: { ...scope.data, changes: {} } })).toBe(false);
  });

  test("parse is the inverse of build; anything else is raw mode (null)", () => {
    const rows = [
      { left: "data.record.amount", op: ">", value: "10", kind: "number" as const },
      { left: "data.record.name", op: "==", value: "O'Neil" , kind: "text" as const},
      { left: "data.record.stage", op: "in", value: "won, lost", kind: "text" as const },
      { left: "data.record.tags", op: "contains", value: "vip", kind: "text" as const },
      { left: "data.record.email", op: "empty", value: "", kind: "text" as const },
      { left: "data.record.stage", op: "changed", value: "", kind: "text" as const },
      { left: "data.record.vip", op: "!=", value: "false", kind: "boolean" as const },
    ];
    expect(ex.parse(ex.build(rows, "||"))).toEqual({ join: "||", rows });
    expect(ex.parse("data.a == 1 && data.b == 2 || data.c == 3")).toBeNull();
    expect(ex.parse("!(data.a == 1)")).toBeNull();
    expect(ex.parse("")).toEqual({ join: "&&", rows: [] });
  });
});

const base = (): WorkflowSpec => ({
  name: "demo",
  trigger: { type: "event", event: "contacts.created" },
  steps: [
    { id: "log_1", type: "action", action: "log", params: { message: "hi" } },
    { id: "check", type: "condition", if: "data.record.stage == 'lead'", then: [{ id: "wait_1", type: "wait", duration: "1h" }], else: [] },
    { id: "log_2", type: "action", action: "log", params: { message: "bye" } },
  ],
});

describe("workflow graph ↔ JSON spec", () => {
  test("flatten lists steps with paths and depth, including branches", () => {
    expect(wf.flatten(base()).map((x) => [x.path, x.step.id, x.depth, x.branch])).toEqual([
      ["steps.0", "log_1", 0, null],
      ["steps.1", "check", 0, null],
      ["steps.1.then.0", "wait_1", 1, "then"],
      ["steps.2", "log_2", 0, null],
    ]);
  });

  test("newStep gives unique ids and type defaults", () => {
    const s = base();
    expect(wf.newStep(s, "action")).toEqual({ id: "action_1", type: "action", action: "", params: {} });
    expect(wf.newStep(s, "wait")).toEqual({ id: "wait_2", type: "wait", duration: "1h" });
    expect(wf.newStep(s, "condition")).toEqual({ id: "condition_1", type: "condition", if: "", then: [], else: [] });
    expect(wf.newStep(s, "approval")).toEqual({ id: "approval_1", type: "approval", approvers: { role: "admin" } });
    expect(wf.newStep(s, "wait_for_event")).toEqual({ id: "wait_for_event_1", type: "wait_for_event", event: "" });
  });

  test("insert and remove are immutable and work inside branches", () => {
    const s = base();
    const a = wf.insert(s, "steps.1.else", 0, { id: "x", type: "wait", duration: "2h" });
    expect((wf.get(a, "steps.1") as any).else.map((x: any) => x.id)).toEqual(["x"]);
    expect((s.steps[1] as any).else).toEqual([]);
    const b = wf.remove(a, "steps.1.then.0");
    expect((wf.get(b, "steps.1") as any).then).toEqual([]);
    expect(wf.get(b, "steps.1.else.0")!.id).toBe("x");
  });

  test("move reorders, nests under a branch and lifts back out", () => {
    let s = base();
    s = wf.move(s, "steps.2", "steps", 0)!;
    expect(s.steps.map((x) => x.id)).toEqual(["log_2", "log_1", "check"]);
    s = wf.move(s, "steps.0", "steps.2.then", 1)!;
    expect(s.steps.map((x) => x.id)).toEqual(["log_1", "check"]);
    expect((s.steps[1] as any).then.map((x: any) => x.id)).toEqual(["wait_1", "log_2"]);
    s = wf.move(s, "steps.1.then.0", "steps", 2)!;
    expect(s.steps.map((x) => x.id)).toEqual(["log_1", "check", "wait_1"]);
    // Moving down within the same list accounts for the removed slot.
    s = wf.move(s, "steps.0", "steps", 2)!;
    expect(s.steps.map((x) => x.id)).toEqual(["check", "log_1", "wait_1"]);
  });

  test("a condition cannot be moved into itself", () => {
    expect(wf.move(base(), "steps.1", "steps.1.then", 0)).toBeNull();
  });

  test("positions lists drop targets for keyboard moves, minus the moved step's own subtree", () => {
    const targets = wf.positions(base(), "steps.1").map((p) => `${p.parent}:${p.index}`);
    expect(targets).toEqual(["steps:0", "steps:2", "steps:3"]);
    const all = wf.positions(base(), "steps.0").map((p) => `${p.parent}:${p.index}`);
    expect(all).toEqual(["steps:1", "steps.1.then:0", "steps.1.then:1", "steps.1.else:0", "steps:2", "steps:3"]);
  });

  test("issues map to the step they belong to (or the spec)", () => {
    const by = wf.issuesByStep([
      { path: "steps.1.then.0.duration", message: "bad", fix: "f" },
      { path: "steps.0.params.message", message: "m", fix: "f" },
      { path: "trigger.event", message: "t", fix: "f" },
      { path: "steps.1.if", message: "e", fix: "f" },
    ]);
    expect(Object.keys(by).sort()).toEqual(["", "steps.0", "steps.1", "steps.1.then.0"]);
    expect(by["steps.1.then.0"][0]).toMatchObject({ field: "duration", message: "bad" });
    expect(by[""][0]).toMatchObject({ field: "trigger.event" });
  });

  test("toSpec drops empty optional values and the result validates", () => {
    const s = wf.insert(base(), "steps", 3, { id: "ev", type: "wait_for_event", event: "email.replied", timeout: "" } as any);
    const out = wf.toSpec({ ...s, description: "" });
    expect(out.description).toBeUndefined();
    expect((out.steps[1] as any).else).toBeUndefined();
    expect((out.steps[3] as any).timeout).toBeUndefined();
    expect(validateSpec(out)).toMatchObject({ ok: true });
  });

  test("resource events for the trigger picker", () => {
    expect(wf.resourceEvents(["contacts", "deals"])).toEqual(["contacts.created", "contacts.updated", "contacts.deleted", "deals.created", "deals.updated", "deals.deleted"]);
  });
});
