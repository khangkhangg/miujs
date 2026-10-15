import { MiuError, type Issue } from "miujs";

const KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY" };

/** Every error @miujs/ai throws. Codes are stable; messages and fixes may improve. */
export const aiErrors = {
  missingKey: (provider: string, envName: string) =>
    new MiuError({
      code: "MIU_E_AI_MISSING_KEY",
      status: 500,
      message: `No API key for the ${provider} provider: env.${envName} is not set`,
      fix: `Set ${envName} in the environment (on Workers: \`wrangler secret put ${envName}\`), or pass ${provider}({ apiKey }) from your own secret store.`,
      details: { provider, env: envName },
    }),

  rateLimited: (provider: string, retryAfter?: number) =>
    new MiuError({
      code: "MIU_E_AI_RATE_LIMITED",
      status: 429,
      message: `The ${provider} API is rate limiting this app`,
      fix:
        (retryAfter ? `Retry after ${retryAfter} seconds. ` : "") +
        "Lower request volume, raise `retries` in ai({ retries }), cache repeated prompts, or ask the provider for a higher rate limit.",
      details: { provider, ...(retryAfter !== undefined ? { retryAfter } : {}) },
    }),

  auth: (provider: string, status: number, message: string) =>
    new MiuError({
      code: "MIU_E_AI_AUTH",
      status: 500,
      message: `The ${provider} API rejected the credentials (${status}): ${message}`,
      fix: `Check that ${KEY_ENV[provider] ?? "the API key"} is a valid, active key for this provider and account.`,
      details: { provider, status },
    }),

  badRequest: (provider: string, status: number, message: string) =>
    new MiuError({
      code: "MIU_E_AI_BAD_REQUEST",
      status: 500,
      message: `The ${provider} API rejected the request (${status}): ${message}`,
      fix: "Check the model id and options against the provider's docs; the provider message above says which field is wrong.",
      details: { provider, status },
    }),

  provider: (provider: string, status: number | undefined, message: string) =>
    new MiuError({
      code: "MIU_E_AI_PROVIDER_ERROR",
      status: 502,
      message: `The ${provider} API failed${status ? ` (${status})` : ""}: ${message}`,
      fix: "The provider is down or overloaded. It was retried with backoff; try again later or raise `retries`.",
      details: { provider, ...(status ? { status } : {}) },
    }),

  timeout: (provider: string, ms: number) =>
    new MiuError({
      code: "MIU_E_AI_TIMEOUT",
      status: 504,
      message: `The ${provider} API did not answer within ${ms} ms`,
      fix: "Raise ai({ timeoutMs }), lower maxTokens, or use ctx.ai.stream() for long outputs.",
      details: { provider, timeoutMs: ms },
    }),

  invalidOutput: (issues: Issue[], output: string) =>
    new MiuError({
      code: "MIU_E_AI_INVALID_OUTPUT",
      status: 502,
      message:
        "The model's output did not match the schema after a retry: " +
        issues
          .slice(0, 5)
          .map((i) => `${i.path || "output"} ${i.message}`)
          .join("; "),
      fix: "Simplify the schema, describe each field (`description`), make hard fields optional, or use a more capable model.",
      details: { issues, output: output.slice(0, 2000) },
    }),

  unsupported: (provider: string, feature: string, fix: string) =>
    new MiuError({
      code: "MIU_E_AI_UNSUPPORTED",
      status: 500,
      message: `The ${provider} provider does not support ${feature}`,
      fix,
      details: { provider, feature },
    }),

  config: (message: string, fix: string) => new MiuError({ code: "MIU_E_AI_CONFIG", status: 500, message, fix }),

  binding: (name: string, kind: string, fix: string) =>
    new MiuError({
      code: "MIU_E_AI_BINDING",
      status: 500,
      message: `${kind} binding ${JSON.stringify(name)} is not available in env`,
      fix,
      details: { binding: name },
    }),

  refused: (provider: string) =>
    new MiuError({
      code: "MIU_E_AI_REFUSED",
      status: 502,
      message: `The ${provider} model declined to answer this request`,
      fix: "Rephrase the request. For Claude, the response's stop_reason was `refusal`; see the provider's refusal docs.",
      details: { provider },
    }),
};
