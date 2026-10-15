import { MiuError, type Issue } from "miujs";

/** Every error @miujs/queue throws. Codes are stable; messages and fixes may improve. */
export const queueErrors = {
  cron: (expr: string, problem: string) =>
    new MiuError({
      code: "MIU_E_QUEUE_CRON",
      status: 500,
      message: `Invalid cron expression ${JSON.stringify(expr)}: ${problem}`,
      fix: 'Use 5 fields "minute hour day-of-month month day-of-week" with *, numbers, a-b ranges, a,b lists and /n steps, e.g. "*/5 * * * *". Times are UTC.',
    }),

  input: (job: string, issues: Issue[]) =>
    new MiuError({
      code: "MIU_E_VALIDATION",
      status: 400,
      message:
        `Invalid input for job "${job}": ` +
        issues
          .slice(0, 5)
          .map((i) => `${i.path || "input"} ${i.message}`)
          .join("; "),
      fix: `Pass input that matches the \`input\` schema in defineJob("${job}", ...) (see miu inspect).`,
      details: { where: `job:${job}`, issues },
    }),

  unknownJob: (job: string, known: string[]) =>
    new MiuError({
      code: "MIU_E_QUEUE_UNKNOWN_JOB",
      status: 500,
      message: `Job "${job}" is not registered with this queue`,
      fix: `Add it to queue({ jobs: [...] }). Registered jobs: ${known.length ? known.join(", ") : "(none)"}.`,
    }),

  duplicateJob: (job: string) =>
    new MiuError({
      code: "MIU_E_QUEUE_JOB_DUPLICATE",
      status: 500,
      message: `Two jobs are named "${job}"`,
      fix: "Give each defineJob() a unique name.",
    }),

  config: (message: string, fix: string) => new MiuError({ code: "MIU_E_QUEUE_CONFIG", status: 500, message, fix }),

  binding: (name: string) =>
    new MiuError({
      code: "MIU_E_QUEUE_BINDING",
      status: 500,
      message: `Queue binding ${JSON.stringify(name)} is not available in env`,
      fix: `Add a queue producer binding to wrangler.toml: [[queues.producers]] binding = "${name}" queue = "<queue-name>", plus a matching [[queues.consumers]] entry.`,
    }),

  timeout: (job: string, seconds: number) =>
    new MiuError({
      code: "MIU_E_QUEUE_TIMEOUT",
      status: 500,
      message: `Job "${job}" did not finish within its ${seconds}s lease and has no attempts left`,
      fix: "Its worker stopped (crash, deploy, scaled down) or stalled. Make the job idempotent and give it `retries`, or raise `visibilityTimeout` if a single run legitimately blocks the event loop that long.",
    }),

  runtime: (what: string, runtime: string, fix: string) =>
    new MiuError({ code: "MIU_E_QUEUE_RUNTIME", status: 500, message: `${what} is not available on ${runtime}`, fix }),

  backend: (code: "REDIS" | "SQLITE", op: string, cause: unknown, fix: string) =>
    new MiuError({
      code: `MIU_E_QUEUE_${code}`,
      status: 500,
      message: `Queue ${code === "REDIS" ? "Redis" : "SQLite"} operation "${op}" failed: ${String((cause as Error)?.message ?? cause)}`,
      fix,
      cause,
    }),

  delay: (delay: unknown, max: number) =>
    new MiuError({
      code: "MIU_E_QUEUE_DELAY",
      status: 500,
      message: `Job delay must be between 0 and ${max} seconds, got ${String(delay)}`,
      fix: `Pass { delay } in seconds, at most ${max}. For longer waits, use a schedule or store the job and dispatch it later.`,
    }),
};
