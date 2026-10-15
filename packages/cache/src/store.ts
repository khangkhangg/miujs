import type { Env } from "miujs";

/** One key as listed by `CacheStore.scan`. Values are never listed. */
export interface CacheKeyInfo {
  key: string;
  /** Length of the stored (JSON) value, when the backend knows it without reading it. */
  bytes: number | null;
  /** Expiry as epoch ms; null for none or unknown. */
  expiresAt: number | null;
}

export interface CacheScanQuery {
  /** Only keys starting with this. */
  prefix?: string;
  /** Opaque cursor from the previous page's `next`. */
  cursor?: string;
  limit: number;
}

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
  /** Total length of the stored (JSON) values, when the backend can tell cheaply. */
  bytes?(): number;
  /** Page through keys (memory; KV when the binding can `list`). Used by `manage()`. */
  scan?(q: CacheScanQuery): Promise<{ keys: CacheKeyInfo[]; next?: string }>;
  /** Remove every entry, returning how many there were. */
  clear?(): Promise<number>;
  /**
   * Stores that depend on per-request bindings (Cloudflare KV by binding name) return the
   * concrete store for this request's `env`.
   */
  forEnv?(env: Env): CacheStore;
  /** Extra details for `miu inspect`. */
  inspect?(): Record<string, unknown>;
}
