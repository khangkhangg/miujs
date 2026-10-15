import type { Env } from "miujs";

/**
 * A cache backend. Values arrive already serialized as JSON text, so a store only moves strings
 * around (memory map, Cloudflare KV, Redis, ...).
 */
export interface CacheStore {
  /** Adapter name shown in `miu inspect`, e.g. "memory" or "kv". */
  readonly name: string;
  get(key: string): Promise<string | undefined>;
  /** `ttl` is in seconds; omitted means "keep until evicted or deleted". */
  set(key: string, value: string, opts?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Number of live entries, when the backend can tell cheaply. */
  size?(): number;
  /**
   * Stores that depend on per-request bindings (Cloudflare KV by binding name) return the
   * concrete store for this request's `env`.
   */
  forEnv?(env: Env): CacheStore;
  /** Extra details for `miu inspect`. */
  inspect?(): Record<string, unknown>;
}
