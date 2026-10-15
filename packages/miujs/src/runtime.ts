export type Runtime = "bun" | "deno" | "node" | "workerd" | "unknown";

declare const Bun: unknown;
declare const Deno: { env: { toObject(): Record<string, string> } } | undefined;
declare const process: { versions?: { node?: string }; env?: Record<string, string | undefined> } | undefined;

let cached: Runtime | undefined;

export function detectRuntime(): Runtime {
  if (cached) return cached;
  if (typeof Bun !== "undefined") cached = "bun";
  else if (typeof Deno !== "undefined") cached = "deno";
  else if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") cached = "workerd";
  else if (typeof process !== "undefined" && process.versions?.node) cached = "node";
  else cached = "unknown";
  return cached;
}

/**
 * The runtime the app is being built for. Same as `detectRuntime()`, except that
 * `MIU_TARGET=cloudflare` (set by `miu deploy cloudflare`) reports `"workerd"`, so plugins pick
 * their Cloudflare defaults and declare the bindings they need.
 */
export function targetRuntime(): Runtime {
  const target = processEnv().MIU_TARGET?.toLowerCase();
  if (target === "cloudflare" || target === "workerd") return "workerd";
  return detectRuntime();
}

/** Process environment on server runtimes. Workers get bindings per request instead. */
export function processEnv(): Record<string, string | undefined> {
  try {
    if (typeof Deno !== "undefined") return Deno.env.toObject();
  } catch {
    // Deno without --allow-env.
    return {};
  }
  if (typeof process !== "undefined" && process.env) return process.env;
  return {};
}
