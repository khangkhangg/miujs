import type { Store } from "../store/types.ts";
import { randomBytes, sha256Hex, toBase64Url } from "./encoding.ts";

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name?: string;
  scopes: string[];
  /** Unix time in milliseconds. */
  createdAt: number;
}

const PREFIX = "miu_";

/**
 * Create an API key for a user. The plaintext key is returned once;
 * only its SHA-256 hash is stored (under `apikey:`).
 */
export async function createApiKey(
  store: Store,
  opts: { userId: string; name?: string; scopes?: string[] },
): Promise<{ key: string; id: string }> {
  const key = PREFIX + toBase64Url(randomBytes(32));
  const id = crypto.randomUUID();
  const record: ApiKeyRecord = { id, userId: opts.userId, name: opts.name, scopes: opts.scopes ?? [], createdAt: Date.now() };
  await keys(store).set(await sha256Hex(key), record);
  return { key, id };
}

/** Look up an API key; undefined when unknown or revoked. */
export async function verifyApiKey(store: Store, key: string): Promise<ApiKeyRecord | undefined> {
  if (!key.startsWith(PREFIX)) return undefined;
  return keys(store).get<ApiKeyRecord>(await sha256Hex(key));
}

/** Revoke an API key. Returns true when it existed. */
export async function revokeApiKey(store: Store, key: string): Promise<boolean> {
  return keys(store).delete(await sha256Hex(key));
}

function keys(store: Store): Store {
  return store.prefix("apikey:");
}
