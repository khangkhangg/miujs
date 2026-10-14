/**
 * Environment detection for dev-only features.
 *
 * Secure default: an environment is "dev" only when it says so explicitly
 * (`MIU_ENV` or `NODE_ENV` = `development`/`dev`/`test`). Anything unknown is
 * treated like production, so dev features never switch on by accident.
 *
 * Variables are looked up in `env` first (Cloudflare Workers bindings: pass
 * `c.env`), then `process.env` (Bun, Node, Workers with nodejs_compat), then
 * `Deno.env`. Non-string values (KV bindings etc.) are ignored.
 */

export type EnvSource = Record<string, unknown> | undefined | null;

const DEV_VALUES = new Set(["development", "dev", "test"]);

function fromRuntime(key: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, unknown> }; Deno?: { env?: { get?: (k: string) => string | undefined } } };
  try {
    const v = g.process?.env?.[key];
    if (typeof v === "string") return v;
  } catch {
    // process.env can be a throwing proxy in some sandboxes.
  }
  try {
    const v = g.Deno?.env?.get?.(key);
    if (typeof v === "string") return v;
  } catch {
    // Deno without --allow-env throws.
  }
  return undefined;
}

/** Reads an environment variable from `env` (e.g. Workers `c.env`) or the runtime's process environment. */
export function readEnv(key: string, env?: EnvSource): string | undefined {
  const v = env && typeof env === "object" ? env[key] : undefined;
  return typeof v === "string" ? v : fromRuntime(key);
}

const norm = (v: string | undefined) => v?.trim().toLowerCase() || undefined;

/** True when `MIU_ENV` or `NODE_ENV` is explicitly `production`. */
export function isProduction(env?: EnvSource): boolean {
  return norm(readEnv("MIU_ENV", env)) === "production" || norm(readEnv("NODE_ENV", env)) === "production";
}

/**
 * True only for an explicit development/test environment. `MIU_ENV` wins over
 * `NODE_ENV`; either one saying `production` always means not dev; an unset or
 * unknown environment (e.g. `staging`) means not dev.
 */
export function isDev(env?: EnvSource): boolean {
  if (isProduction(env)) return false;
  const miu = norm(readEnv("MIU_ENV", env));
  if (miu) return DEV_VALUES.has(miu);
  const node = norm(readEnv("NODE_ENV", env));
  return node ? DEV_VALUES.has(node) : false;
}

/**
 * Resolves whether a dev-only feature is on for this request.
 * `enabled` defaults to `isDev(env)`; production always turns it off unless `force` is set.
 */
export function devFeatureEnabled(opts: { enabled?: boolean; force?: boolean }, env?: EnvSource): boolean {
  if (isProduction(env) && !opts.force) return false;
  return opts.enabled ?? isDev(env);
}
