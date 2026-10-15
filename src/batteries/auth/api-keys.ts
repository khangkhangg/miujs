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
  const hash = await sha256Hex(key);
  await keys(store).set(hash, record);
  // Indexes for management without the plaintext: id -> hash, and the user's key ids.
  await store.prefix("apikey-id:").set(id, hash);
  const ids = store.prefix("apikey-user:");
  await ids.set(opts.userId, [...((await ids.get<string[]>(opts.userId)) ?? []), id]);
  return { key, id };
}

/** Look up an API key; undefined when unknown or revoked. */
export async function verifyApiKey(store: Store, key: string): Promise<ApiKeyRecord | undefined> {
  if (!key.startsWith(PREFIX)) return undefined;
  return keys(store).get<ApiKeyRecord>(await sha256Hex(key));
}

/** Revoke an API key. Returns true when it existed. */
export async function revokeApiKey(store: Store, key: string): Promise<boolean> {
  const hash = await sha256Hex(key);
  const record = await keys(store).get<ApiKeyRecord>(hash);
  if (record) await forget(store, record);
  return keys(store).delete(hash);
}

/** A user's API keys (metadata only — the plaintext is never stored). */
export async function listApiKeys(store: Store, userId: string): Promise<ApiKeyRecord[]> {
  const out: ApiKeyRecord[] = [];
  for (const id of (await store.prefix("apikey-user:").get<string[]>(userId)) ?? []) {
    const hash = await store.prefix("apikey-id:").get<string>(id);
    const record = hash && (await keys(store).get<ApiKeyRecord>(hash));
    if (record) out.push(record);
  }
  return out;
}

/** Revoke an API key by its id (e.g. from a "your keys" page). Returns true when it existed. */
export async function revokeApiKeyById(store: Store, id: string): Promise<boolean> {
  const hash = await store.prefix("apikey-id:").get<string>(id);
  if (!hash) return false;
  const record = await keys(store).get<ApiKeyRecord>(hash);
  if (record) await forget(store, record);
  else await store.prefix("apikey-id:").delete(id);
  return keys(store).delete(hash);
}

async function forget(store: Store, record: ApiKeyRecord): Promise<void> {
  await store.prefix("apikey-id:").delete(record.id);
  const ids = store.prefix("apikey-user:");
  const left = ((await ids.get<string[]>(record.userId)) ?? []).filter((x) => x !== record.id);
  if (left.length) await ids.set(record.userId, left);
  else await ids.delete(record.userId);
}

function keys(store: Store): Store {
  return store.prefix("apikey:");
}
