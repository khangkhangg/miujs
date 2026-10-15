import { MiuError } from "miujs";

/** Every error @miujs/cache throws. Codes are stable; messages and fixes may improve. */
export const cacheErrors = {
  config: (message: string, fix: string) => new MiuError({ code: "MIU_E_CACHE_CONFIG", status: 500, message, fix }),

  key: (what: "key" | "tag", value: unknown) =>
    new MiuError({
      code: "MIU_E_CACHE_KEY",
      status: 500,
      message: `Cache ${what} must be a non-empty string, got ${JSON.stringify(value) ?? String(value)}`,
      fix: `Pass a non-empty string ${what}, e.g. \`user:\${id}\`.`,
    }),

  ttl: (ttl: unknown) =>
    new MiuError({
      code: "MIU_E_CACHE_TTL",
      status: 500,
      message: `Cache ttl must be a positive number of seconds, got ${String(ttl)}`,
      fix: "Pass `ttl` in seconds (e.g. 60), or omit it to keep the entry until it is evicted or deleted.",
    }),

  value: (key: string, cause?: unknown) =>
    new MiuError({
      code: "MIU_E_CACHE_VALUE",
      status: 500,
      message: `Cannot cache ${JSON.stringify(key)}: the value is not JSON-serializable`,
      fix: "Cache plain JSON data (objects, arrays, strings, numbers, booleans, null). Convert Dates to strings and BigInts to strings or numbers; `undefined` cannot be cached.",
      cause,
    }),

  redis: (op: string, key: string, cause: unknown) =>
    new MiuError({
      code: "MIU_E_CACHE_REDIS",
      status: 500,
      message: `Redis ${op} for cache key ${JSON.stringify(key)} failed: ${String((cause as Error)?.message ?? cause)}`,
      fix: "Check that Redis is running and reachable at REDIS_URL (or the url passed to bunRedis()), and that the credentials and TLS settings are right.",
      cause,
    }),

  binding: (name: string) =>
    new MiuError({
      code: "MIU_E_CACHE_BINDING",
      status: 500,
      message: `KV binding ${JSON.stringify(name)} is not available in env`,
      fix: `Add a KV namespace binding named "${name}" to wrangler.toml ([[kv_namespaces]] binding = "${name}"), or pass a different name to kvStore().`,
    }),
};
