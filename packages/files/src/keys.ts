import { filesErrors } from "./errors.ts";

const MAX_KEY_BYTES = 1024;
const enc = new TextEncoder();

/**
 * Validate an object key. Every store applies the same rules, so a key that works in memory
 * works on disk and on R2. The local store re-checks the resolved path on top of this.
 */
export function checkKey(key: unknown): string {
  if (typeof key !== "string" || key === "") throw filesErrors.keyInvalid(key, "must be a non-empty string");
  if (enc.encode(key).length > MAX_KEY_BYTES) throw filesErrors.keyInvalid(key.slice(0, 40) + "...", `longer than ${MAX_KEY_BYTES} bytes`);
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) throw filesErrors.keyInvalid(key, "contains a control character or NUL");
    if (c === 0x5c) throw filesErrors.keyInvalid(key, "contains a backslash");
    if (c === 0x3a) throw filesErrors.keyInvalid(key, "contains ':'");
  }
  if (key.startsWith("/")) throw filesErrors.keyInvalid(key, "must be relative (no leading '/')");
  for (const seg of key.split("/")) {
    if (seg === "") throw filesErrors.keyInvalid(key, "has an empty segment");
    if (seg === "." || seg === "..") throw filesErrors.keyInvalid(key, `has a '${seg}' segment`);
  }
  return key;
}
