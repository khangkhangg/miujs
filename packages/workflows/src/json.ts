// JSON-defined workflows: the format a visual builder saves. Validated with precise
// path + fix issues, then interpreted on top of the same durable step API.

import { errors, t, validate, type Issue, type Schema } from "miujs";
import { parseCron } from "@miujs/queue";
import { BUILTIN_ACTIONS, type ActionDef } from "./actions.ts";
import { cron, defineWorkflow, manual, on, webhook, type Trigger, type WorkflowContext, type WorkflowDef } from "./define.ts";
import { parseDuration } from "./duration.ts";
import { workflowErrors, type SpecIssue } from "./errors.ts";
import { compileExpression, hasTemplate, interpolate, templateExpressions, type Scope } from "./expr.ts";

export type SpecTrigger =
  | { type: "event"; event: string; match?: Record<string, unknown> }
  | { type: "cron"; cron: string }
  | { type: "webhook"; path: string; secretEnv?: string; header?: string }
  | { type: "manual" };

export type SpecStep =
  | { id: string; type: "action"; action: string; params?: Record<string, unknown>; retries?: number }
  | { id: string; type: "condition"; if: string; then: SpecStep[]; else?: SpecStep[] }
  | { id: string; type: "wait"; duration: string | number }
  | { id: string; type: "wait_for_event"; event: string; match?: Record<string, unknown>; timeout?: string | number }
  | { id: string; type: "approval"; approvers: { role?: string | string[]; users?: string[] }; timeout?: string | number };

export interface WorkflowSpec {
  name: string;
  description?: string;
  trigger: SpecTrigger;
  /** `key` is an expression over data/input, e.g. "data.contactId". */
  concurrency?: { key: string; limit?: number };
  steps: SpecStep[];
}

export interface JsonOptions {
  /** Extra actions (built-ins: http, send_email, log). */
  actions?: ActionDef[];
}

const STEP_TYPES = ["action", "condition", "wait", "wait_for_event", "approval"] as const;
const TRIGGER_TYPES = ["event", "cron", "webhook", "manual"] as const;
const ROOTS = ["data", "input", "steps"];

const FIX = {
  object: "The spec must be a JSON object: { name, trigger, steps }.",
  name: 'Add "name": "deal-approval" (letters, digits, ".", "_" or "-").',
  trigger: 'Set "trigger" to {"type":"event","event":"deal.updated"}, {"type":"cron","cron":"0 9 * * 1"}, {"type":"webhook","path":"/hooks/x"} or {"type":"manual"}.',
  steps: 'Add a "steps" array with at least one step, e.g. {"id":"pause","type":"wait","duration":"1d"}.',
  id: 'Give each step a unique "id": a letter, then letters, digits, "_" or "-".',
  type: `Use "type": one of ${STEP_TYPES.join(", ")}.`,
  approvers: 'Set "approvers": {"role": "manager"} or {"users": ["user-id"]}.',
  concurrency: 'Use "concurrency": {"key": "data.contactId", "limit": 1}.',
};

const ALLOWED: Record<string, string[]> = {
  spec: ["name", "description", "trigger", "concurrency", "steps"],
  event: ["type", "event", "match"],
  cron: ["type", "cron"],
  webhook: ["type", "path", "secretEnv", "header"],
  manual: ["type"],
  action: ["id", "type", "action", "params", "retries"],
  condition: ["id", "type", "if", "then", "else"],
  wait: ["id", "type", "duration"],
  wait_for_event: ["id", "type", "event", "match", "timeout"],
  approval: ["id", "type", "approvers", "timeout"],
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

class Checker {
  issues: SpecIssue[] = [];
  ids = new Map<string, string>();
  actions: Map<string, ActionDef>;
  allIds = new Set<string>();

  constructor(actions: Map<string, ActionDef>) {
    this.actions = actions;
  }

  push(path: string, message: string, fix: string) {
    this.issues.push({ path, message, fix });
  }

  schema(s: Schema, value: unknown, path: string, fix: string) {
    const r = validate(s, value, { path });
    if (!r.ok) for (const i of r.issues) this.push(i.path, i.message, fix);
  }

  keys(obj: Record<string, unknown>, allowed: string[], path: string) {
    for (const k of Object.keys(obj)) {
      if (allowed.includes(k)) continue;
      const near = allowed.find((a) => distance(a, k) <= 2);
      this.push(join(path, k), "is not a known key", near ? `Remove it, or did you mean "${near}"?` : `Remove it. Allowed keys: ${allowed.join(", ")}.`);
    }
  }

  expression(src: unknown, path: string, roots = ROOTS) {
    if (typeof src !== "string") return;
    try {
      const c = compileExpression(src, { roots });
      for (const p of c.paths) {
        if (p[0] !== "steps") continue;
        if (p.length < 2 || !this.allIds.has(p[1])) {
          this.push(path, `references unknown step "${p[1] ?? ""}"`, `Reference a step id from this workflow as steps.<id>.output. Ids: ${[...this.allIds].join(", ") || "(none)"}.`);
        } else if (p.length > 2 && p[2] !== "output") {
          this.push(path, `reads steps.${p[1]}.${p[2]}`, `Step results live under steps.${p[1]}.output.`);
        }
      }
    } catch (err) {
      const e = err as { message: string; fix?: string };
      this.push(path, e.message, e.fix ?? "Fix the expression.");
    }
  }

  templates(value: unknown, path: string) {
    if (typeof value === "string") {
      for (const src of templateExpressions(value)) this.expression(src, path);
      if (/\{\{(?![\s\S]*\}\})/.test(value)) this.push(path, "has an unclosed {{", "Close every template: {{ data.field }}.");
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => this.templates(v, join(path, i)));
    else if (isObj(value)) for (const [k, v] of Object.entries(value)) this.templates(v, join(path, k));
  }

  duration(v: unknown, path: string, required: boolean) {
    if (v === undefined) {
      if (required) this.push(path, "is required", 'Use a duration like "30m", "12h" or "1d".');
      return;
    }
    try {
      parseDuration(v as string);
    } catch (err) {
      this.push(path, (err as Error).message, (err as { fix?: string }).fix ?? "Use a duration like \"1d\".");
    }
  }

  collect(steps: unknown) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
      if (!isObj(s)) continue;
      if (typeof s.id === "string") this.allIds.add(s.id);
      this.collect(s.then);
      this.collect(s.else);
    }
  }

  trigger(tr: unknown) {
    if (tr === undefined) return this.push("trigger", "is required", FIX.trigger);
    if (!isObj(tr)) return this.push("trigger", "must be an object", FIX.trigger);
    if (!TRIGGER_TYPES.includes(tr.type as never)) return this.push("trigger.type", `must be one of ${TRIGGER_TYPES.join(", ")}`, FIX.trigger);
    this.keys(tr, ALLOWED[tr.type as string], "trigger");
    if (tr.type === "event") {
      this.schema(t.string({ minLength: 1 }), tr.event, "trigger.event", 'Set "event": "deal.updated".');
      if (tr.match !== undefined && !isObj(tr.match)) this.push("trigger.match", "must be an object", 'Use "match": {"data.stage": "won"}.');
    } else if (tr.type === "cron") {
      if (typeof tr.cron !== "string") this.push("trigger.cron", "is required", 'Set "cron": "0 9 * * 1" (5 fields, UTC).');
      else {
        try {
          parseCron(tr.cron);
        } catch (err) {
          this.push("trigger.cron", (err as Error).message, (err as { fix?: string }).fix ?? "Fix the cron expression.");
        }
      }
    } else if (tr.type === "webhook") {
      if (typeof tr.path !== "string" || !tr.path.startsWith("/")) this.push("trigger.path", 'must be a path starting with "/"', 'Set "path": "/hooks/form".');
      if (tr.secretEnv !== undefined && typeof tr.secretEnv !== "string") this.push("trigger.secretEnv", "must be a string", 'Name the env var holding the HMAC secret, e.g. "FORM_SECRET".');
      if (tr.header !== undefined && typeof tr.header !== "string") this.push("trigger.header", "must be a string", 'Name the signature header, e.g. "x-signature".');
    }
  }

  steps(steps: unknown, path: string, nonEmpty: boolean) {
    if (!Array.isArray(steps)) return this.push(path, steps === undefined ? "is required" : "must be an array", FIX.steps);
    if (nonEmpty && steps.length === 0) return this.push(path, "must have at least 1 step", FIX.steps);
    steps.forEach((s, i) => this.step(s, join(path, i)));
  }

  step(s: unknown, path: string) {
    if (!isObj(s)) return this.push(path, "must be an object", 'Each step is an object like {"id":"pause","type":"wait","duration":"1d"}.');
    if (typeof s.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(s.id)) this.push(join(path, "id"), s.id === undefined ? "is required" : "must be an identifier", FIX.id);
    else if (this.ids.has(s.id)) this.push(join(path, "id"), `duplicate id "${s.id}" (first at ${this.ids.get(s.id)})`, FIX.id);
    else this.ids.set(s.id, path);
    if (!STEP_TYPES.includes(s.type as never)) return this.push(join(path, "type"), s.type === undefined ? "is required" : `unknown step type ${JSON.stringify(s.type)}`, FIX.type);
    this.keys(s, ALLOWED[s.type as string], path);

    switch (s.type) {
      case "action": {
        const known = [...this.actions.keys()];
        if (typeof s.action !== "string") return this.push(join(path, "action"), "is required", `Set "action" to one of: ${known.join(", ")}.`);
        const action = this.actions.get(s.action);
        if (!action) return this.push(join(path, "action"), `unknown action "${s.action}"`, `Use one of: ${known.join(", ")}, or register it with defineAction("${s.action}", { params, run }) and pass it to fromJson(spec, { actions }).`);
        if (s.params !== undefined && !isObj(s.params)) return this.push(join(path, "params"), "must be an object", `Pass "params": { ... } for action "${s.action}".`);
        if (s.retries !== undefined) this.schema(t.integer({ min: 0, max: 20 }), s.retries, join(path, "retries"), 'Use "retries": 0 to 20.');
        const params = (s.params ?? {}) as Record<string, unknown>;
        this.params(action, params, join(path, "params"));
        this.templates(params, join(path, "params"));
        return;
      }
      case "condition":
        if (typeof s.if !== "string") this.push(join(path, "if"), "is required", `Set "if" to an expression, e.g. "data.amount > 10000 && data.stage == 'won'".`);
        else this.expression(s.if, join(path, "if"));
        this.steps(s.then, join(path, "then"), false);
        if (s.else !== undefined) this.steps(s.else, join(path, "else"), false);
        return;
      case "wait":
        return this.duration(s.duration, join(path, "duration"), true);
      case "wait_for_event":
        this.schema(t.string({ minLength: 1 }), s.event, join(path, "event"), 'Set "event": "email.replied".');
        if (s.match !== undefined) {
          if (!isObj(s.match)) this.push(join(path, "match"), "must be an object", 'Use "match": {"data.contactId": "{{ data.contactId }}"}.');
          else this.templates(s.match, join(path, "match"));
        }
        return this.duration(s.timeout, join(path, "timeout"), false);
      case "approval": {
        const a = s.approvers;
        const roleOk = (r: unknown) => typeof r === "string" || (Array.isArray(r) && r.every((x) => typeof x === "string"));
        if (!isObj(a)) this.push(join(path, "approvers"), "is required", FIX.approvers);
        else if ((a.role === undefined && a.users === undefined) || (a.role !== undefined && !roleOk(a.role)) || (a.users !== undefined && !(Array.isArray(a.users) && a.users.every((x) => typeof x === "string")))) {
          this.push(join(path, "approvers"), "needs role (string or list) and/or users (list of ids)", FIX.approvers);
        }
        return this.duration(s.timeout, join(path, "timeout"), false);
      }
    }
  }

  /** Validate params against the action schema, ignoring values that are only known after interpolation. */
  params(action: ActionDef, params: Record<string, unknown>, path: string) {
    const r = validate(action.params, params, { path });
    if (r.ok) return;
    const required = Object.entries((action.params.json.properties as Record<string, unknown>) ?? {})
      .filter(([k]) => ((action.params.json.required as string[]) ?? []).includes(k))
      .map(([k]) => k);
    for (const issue of r.issues) {
      if (templatedAt(params, issue.path.slice(path.length + 1))) continue;
      this.push(issue.path, issue.message, `Pass params that match action "${action.name}"${required.length ? ` (required: ${required.join(", ")})` : ""}. Schema: ${JSON.stringify(action.params.json)}`);
    }
  }
}

function templatedAt(params: unknown, rel: string): boolean {
  let v: unknown = params;
  if (hasTemplate(v)) return true;
  for (const k of rel ? rel.split(".") : []) {
    if (!isObj(v) && !Array.isArray(v)) return false;
    v = (v as Record<string, unknown>)[k];
    if (hasTemplate(v)) return true;
  }
  return false;
}

function actionMap(extra: readonly ActionDef[] = []): Map<string, ActionDef> {
  const m = new Map<string, ActionDef>();
  for (const a of [...BUILTIN_ACTIONS, ...extra]) m.set(a.name, a);
  return m;
}

/**
 * Check a spec without building it (for builders). Every issue has a dotted `path`
 * (e.g. `steps.2.then.0.params.url`), a `message` and a `fix`.
 */
export function validateSpec(spec: unknown, opts: JsonOptions = {}): { ok: true; spec: WorkflowSpec } | { ok: false; issues: SpecIssue[] } {
  const c = new Checker(actionMap(opts.actions));
  if (!isObj(spec)) return { ok: false, issues: [{ path: "", message: "must be an object", fix: FIX.object }] };
  c.keys(spec, ALLOWED.spec, "");
  if (spec.name === undefined) c.push("name", "is required", FIX.name);
  else if (typeof spec.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.name)) c.push("name", "must be a name like deal-approval", FIX.name);
  if (spec.description !== undefined && typeof spec.description !== "string") c.push("description", "must be a string", "Use a short sentence.");
  c.trigger(spec.trigger);
  if (spec.concurrency !== undefined) {
    const cc = spec.concurrency;
    if (!isObj(cc) || typeof cc.key !== "string") c.push("concurrency", "needs a key expression", FIX.concurrency);
    else {
      c.keys(cc, ["key", "limit"], "concurrency");
      c.expression(cc.key, "concurrency.key", ["data", "input"]);
      if (cc.limit !== undefined) c.schema(t.integer({ min: 1 }), cc.limit, "concurrency.limit", FIX.concurrency);
    }
  }
  c.collect(spec.steps);
  c.steps(spec.steps, "steps", true);
  return c.issues.length ? { ok: false, issues: c.issues } : { ok: true, spec: spec as unknown as WorkflowSpec };
}

function toTrigger(tr: SpecTrigger): Trigger {
  switch (tr.type) {
    case "event":
      return on(tr.event, tr.match ? { match: tr.match } : {});
    case "cron":
      return cron(tr.cron);
    case "webhook": {
      const name = tr.secretEnv;
      return webhook(tr.path, { ...(name ? { secret: (env) => env[name] as string | undefined } : {}), ...(tr.header ? { header: tr.header } : {}) });
    }
    default:
      return manual();
  }
}

function paramsError(action: string, issues: Issue[]) {
  return Object.assign(errors.validation(`params of action "${action}"`, issues), { retryable: false });
}

/**
 * Build a workflow from a JSON spec (what a visual builder saves). Throws
 * MIU_E_WORKFLOW_SPEC_INVALID listing every problem with its path and fix.
 */
export function fromJson(spec: unknown, opts: JsonOptions = {}): WorkflowDef<Record<string, unknown>> {
  const checked = validateSpec(spec, opts);
  if (!checked.ok) throw workflowErrors.spec(isObj(spec) && typeof spec.name === "string" ? spec.name : "", checked.issues);
  const s = structuredClone(checked.spec);
  const actions = actionMap(opts.actions);

  const runSteps = async (steps: SpecStep[], ctx: WorkflowContext<Record<string, unknown>>, scope: Scope & { steps: Record<string, { output: unknown }> }): Promise<void> => {
    for (const st of steps) {
      switch (st.type) {
        case "action": {
          const action = actions.get(st.action)!;
          const output = await ctx.step.run(
            st.id,
            async () => {
              const params = validate(action.params, interpolate(st.params ?? {}, scope));
              if (!params.ok) throw paramsError(action.name, params.issues);
              return action.run(params.value, { env: ctx.env, log: ctx.log, fetch: ctx.fetch, mailer: ctx.mailer, run: { id: ctx.run.id, workflow: ctx.run.workflow }, input: ctx.input });
            },
            { retries: st.retries ?? action.retries },
          );
          scope.steps[st.id] = { output };
          break;
        }
        case "condition":
          // Deterministic: the scope only holds the input and journaled step outputs.
          await runSteps(compileExpression(st.if).evaluate(scope) ? st.then : (st.else ?? []), ctx, scope);
          break;
        case "wait":
          await ctx.step.sleep(st.id, st.duration);
          scope.steps[st.id] = { output: null };
          break;
        case "wait_for_event": {
          const match = st.match ? (interpolate(st.match, scope) as Record<string, unknown>) : undefined;
          scope.steps[st.id] = { output: await ctx.step.waitForEvent(st.id, { event: st.event, match, timeout: st.timeout }) };
          break;
        }
        case "approval":
          scope.steps[st.id] = { output: await ctx.step.waitForApproval(st.id, { approvers: st.approvers, timeout: st.timeout }) };
          break;
      }
    }
  };

  const keyExpr = s.concurrency ? compileExpression(s.concurrency.key, { roots: ["data", "input"] }) : null;
  const def = defineWorkflow(s.name, {
    description: s.description,
    trigger: toTrigger(s.trigger),
    input: t.record(t.unknown()),
    concurrency: keyExpr ? { key: (input) => String(keyExpr.evaluate({ data: input, input })), limit: s.concurrency!.limit ?? 1 } : undefined,
    run: async (ctx) => {
      const scope = { data: ctx.input, input: ctx.input, steps: {} as Record<string, { output: unknown }> };
      await runSteps(s.steps, ctx, scope);
      return { steps: scope.steps };
    },
  });
  return { ...def, spec: s, actions: [...actions.keys()] };
}
