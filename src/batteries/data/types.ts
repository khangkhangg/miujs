/**
 * A minimal document repository: the shared persistence interface for the admin back-office, the tour kit
 * and user code. Drivers: memory (dev/tests), SQLite and D1 (JSON documents), and anything else that
 * implements these five methods.
 */
export interface Doc {
  id: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ListQuery {
  /** Case-insensitive substring search over the repository's searchable fields. */
  q?: string;
  /** Exact-match filters on top-level fields. */
  where?: Record<string, string | number | boolean | null>;
  /** Field name; prefix with "-" for descending. */
  sort?: string;
  /** Default 50, capped at 1000. */
  limit?: number;
  offset?: number;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

export type CreateInput<T extends Doc> = Omit<T, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface Repository<T extends Doc> {
  list(query?: ListQuery): Promise<ListResult<T>>;
  get(id: string): Promise<T | undefined>;
  /** Assigns `id` (unless given), `createdAt` and `updatedAt`. Throws on a duplicate id. */
  create(data: CreateInput<T>): Promise<T>;
  /** Shallow-merges `patch`; `id` and `createdAt` never change. Undefined when missing. */
  update(id: string, patch: Partial<T>): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** 16 random bytes as base64url: unguessable ids that are safe in URLs and storage keys. */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Validates a sort/where field name so drivers can safely use it in queries. */
export function assertField(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`Invalid field name: ${name}`);
  return name;
}
