// HMAC keys for the audit chain: parsing, validation, ids and signing.

import { errors, type Env } from "miujs";

/** A secret (id derived from it) or `{ id, secret }`. */
export type AuditKey = string | { id: string; secret: string };
/** One key, or several: the first signs new rows, all of them verify. */
export type AuditKeys = AuditKey | AuditKey[];

/** The key object Web Crypto returns (`CryptoKeyLike`), named without lib "dom". */
export type CryptoKeyLike = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface ResolvedKey {
  id: string;
  key: CryptoKeyLike;
  /** The raw secret, for a synchronous HMAC where the runtime has one (Bun). Not enumerable. */
  readonly secret?: string;
}

export const MIN_KEY_LENGTH = 32;
export const ENV_KEY = "AUDIT_HMAC_KEY";

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

const weak = (why: string) =>
  errors.config(
    "MIU_E_AUDIT_KEY_WEAK",
    `Audit HMAC key rejected: ${why}`,
    `Use a random secret of at least ${MIN_KEY_LENGTH} characters, e.g. \`openssl rand -base64 48\`, in AUDIT_HMAC_KEY or audit({ key }). To rotate, list keys newest first: [newKey, oldKey].`,
  );

/** Validates keys synchronously (lengths, ids). Throws MIU_E_AUDIT_KEY_WEAK. */
export function checkKeys(keys: AuditKeys): { id?: string; secret: string }[] {
  const list = Array.isArray(keys) ? keys : [keys];
  if (!list.length) throw weak("the key list is empty");
  const seen = new Set<string>();
  return list.map((k) => {
    const secret = typeof k === "string" ? k : k?.secret;
    const id = typeof k === "string" ? undefined : k?.id;
    if (typeof secret !== "string" || secret.length < MIN_KEY_LENGTH) throw weak(`keys must be at least ${MIN_KEY_LENGTH} characters`);
    if (id !== undefined) {
      if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) throw weak("key ids must be 1–64 characters of letters, digits and . _ : -");
      if (seen.has(id)) throw weak(`duplicate key id ${JSON.stringify(id)}`);
      seen.add(id);
    }
    return { id, secret };
  });
}

/** Keys from `AUDIT_HMAC_KEY` (comma-separated, newest first), or null when unset. */
export function envKeys(env: Env | undefined): string[] | null {
  const v = env?.[ENV_KEY];
  if (typeof v !== "string" || v.trim() === "") return null;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const cache = new Map<string, Promise<ResolvedKey>>();

async function resolveOne(id: string | undefined, secret: string): Promise<ResolvedKey> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // A derived id is an HMAC of a constant: stable, short, and reveals nothing about the secret.
  const derived = id ?? `k_${hex(await crypto.subtle.sign("HMAC", key, enc.encode("miujs-audit-key-id"))).slice(0, 16)}`;
  const out: ResolvedKey = { id: derived, key };
  Object.defineProperty(out, "secret", { value: secret, enumerable: false });
  return out;
}

/** Imports keys (cached per id+secret). The first entry signs. */
export async function resolveKeys(keys: AuditKeys): Promise<ResolvedKey[]> {
  const list = checkKeys(keys);
  return Promise.all(
    list.map(({ id, secret }) => {
      const ck = `${id ?? ""}\u0000${secret}`;
      let p = cache.get(ck);
      if (!p) {
        p = resolveOne(id, secret);
        if (cache.size > 64) cache.clear();
        cache.set(ck, p);
      }
      return p;
    }),
  );
}

export async function hmacHex(key: CryptoKeyLike, data: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Constant-time comparison of two hex strings. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Keyed hash of a normalized (trimmed, lower-cased) email, for logging failed sign-ins without the address. */
export async function hashAuditEmail(email: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hmacHex(key, `miujs-audit-email\n${email.trim().toLowerCase()}`);
}
