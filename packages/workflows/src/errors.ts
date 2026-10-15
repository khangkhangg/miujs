import { MiuError, type Issue } from "miujs";

/** A spec problem with where it is and what to change. */
export interface SpecIssue extends Issue {
  fix: string;
}

/** Every error @miujs/workflows throws. Codes are stable; messages and fixes may improve. */
export const workflowErrors = {
  config: (message: string, fix: string, details?: unknown) =>
    new MiuError({ code: "MIU_E_WORKFLOW_CONFIG", status: 500, message, fix, details }),

  duration: (value: unknown) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_DURATION",
      status: 400,
      message: `Invalid duration ${JSON.stringify(value)}`,
      fix: 'Use a positive number of milliseconds or a string like "500ms", "30s", "5m", "12h", "1d", "2w" (also "3 days", "2 hours").',
    }),

  expression: (source: string, problem: string, at?: number) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_EXPRESSION",
      status: 400,
      message: `Invalid expression ${JSON.stringify(source)}: ${problem}${at === undefined ? "" : ` (at ${at})`}`,
      fix: "Expressions support literals ('text', 42, true, null, [a, b]), paths (data.x, input.x, steps.<id>.output.x), == != > >= < <=, && || !, parentheses and `in`. Nothing else (no calls, no assignment).",
    }),

  duplicateStep: (workflow: string, step: string) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_STEP_DUPLICATE",
      status: 500,
      message: `Workflow "${workflow}" used the step name "${step}" twice in one run`,
      fix: "Step names identify journaled results, so each must be unique per run. In loops, include the index or item id: step.run(`send-${i}`, ...).",
    }),

  duplicateWorkflow: (name: string) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_DUPLICATE",
      status: 500,
      message: `Two workflows are named "${name}"`,
      fix: "Give each defineWorkflow() / fromJson() a unique name.",
    }),

  unknownWorkflow: (name: string, known: string[]) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_UNKNOWN",
      status: 404,
      message: `Workflow "${name}" is not registered`,
      fix: `Add it to workflows({ workflows: [...] }). Registered: ${known.length ? known.join(", ") : "(none)"}.`,
    }),

  runNotFound: (id: string) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_RUN_NOT_FOUND",
      status: 404,
      message: `Workflow run ${JSON.stringify(id)} not found`,
      fix: "List runs with GET /workflows/runs (or the workflow_runs MCP tool) to find a valid id.",
    }),

  runState: (id: string, status: string, action: string, allowed: string) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_RUN_STATE",
      status: 409,
      message: `Cannot ${action} run ${id}: it is ${status}`,
      fix: `Only ${allowed} runs can be ${action === "retry" ? "retried" : `${action}ed`}.`,
    }),

  input: (workflow: string, issues: Issue[]) =>
    new MiuError({
      code: "MIU_E_VALIDATION",
      status: 400,
      message:
        `Invalid input for workflow "${workflow}": ` +
        issues
          .slice(0, 5)
          .map((i) => `${i.path || "input"} ${i.message}`)
          .join("; "),
      fix: `Pass input that matches the \`input\` schema of workflow "${workflow}" (see GET /workflows).`,
      details: { where: `workflow:${workflow}`, issues },
    }),

  spec: (name: string, issues: SpecIssue[]) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_SPEC_INVALID",
      status: 400,
      message:
        `Invalid workflow spec${name ? ` "${name}"` : ""}: ` +
        issues
          .slice(0, 5)
          .map((i) => `${i.path || "spec"} ${i.message}`)
          .join("; "),
      fix: issues[0]?.fix ?? "Fix the spec.",
      details: { issues },
    }),

  unknownAction: (action: string, known: string[]) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_ACTION_UNKNOWN",
      status: 400,
      message: `Action "${action}" is not registered`,
      fix: `Use one of: ${known.join(", ")}, or register it with defineAction("${action}", { params, run }) and pass it to fromJson(spec, { actions }).`,
    }),

  mailer: () =>
    new MiuError({
      code: "MIU_E_WORKFLOW_MAILER_MISSING",
      status: 500,
      message: "The send_email action has no mailer",
      fix: "Pass workflows({ mailer: { send(msg) {...} } }) (any object with send(), e.g. the @miujs/mail client), or add a plugin named \"mail\" that has send().",
    }),

  reservedEvent: (name: string) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_EVENT_RESERVED",
      status: 400,
      message: `The event name "${name}" is reserved`,
      fix: "Approvals are decided with POST /workflows/approvals/:runId/:step, not by emitting events. Use another event name.",
    }),

  signature: () =>
    new MiuError({
      code: "MIU_E_WORKFLOW_SIGNATURE",
      status: 401,
      message: "Webhook signature is missing or does not match",
      fix: "Send the hex HMAC-SHA256 of the raw request body, keyed with the webhook secret, in the configured header (\"sha256=\" prefix optional).",
    }),

  approver: (step: string) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_NOT_APPROVER",
      status: 403,
      message: `You are not an approver for step "${step}"`,
      fix: "Sign in as a user with one of the approver roles (or ids) listed in the run's step timeline.",
    }),

  noApproval: (runId: string, step: string) =>
    new MiuError({
      code: "MIU_E_WORKFLOW_APPROVAL_NOT_PENDING",
      status: 404,
      message: `Run ${runId} has no pending approval named "${step}"`,
      fix: "Check GET /workflows/runs/:id: the run must be waiting on that approval step (it may have been decided or timed out).",
    }),
};

/** Throw this from a step to fail it immediately, without retries. */
export class NonRetryableError extends Error {
  readonly retryable = false;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** Thrown into workflow code when a step has failed every attempt. */
export class StepFailedError extends Error {
  readonly step: string;
  readonly code?: string;
  constructor(step: string, message: string, code?: string) {
    super(message);
    this.name = "StepFailedError";
    this.step = step;
    this.code = code;
  }
}
