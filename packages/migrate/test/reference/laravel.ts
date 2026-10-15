// Independent reference implementation of Laravel's Illuminate\Encryption\Encrypter and
// Illuminate\Cookie\CookieValuePrefix, written with node:crypto (OpenSSL) rather than WebCrypto,
// line by line from the PHP source (Laravel 10/11):
//
//   encrypt($value, $serialize = true):
//     $iv    = random_bytes(openssl_cipher_iv_length($cipher));        // 16 for CBC, 12 for GCM
//     $value = openssl_encrypt($serialize ? serialize($value) : $value, $cipher, $key, 0, $iv, $tag);
//              // options = 0 → OpenSSL returns the ciphertext base64-encoded, PKCS#7 padded
//     $iv    = base64_encode($iv);
//     $tag   = base64_encode($tag ?? '');
//     $mac   = $aead ? '' : hash_hmac('sha256', $iv.$value, $key);     // hex, over the base64 strings
//     return base64_encode(json_encode(compact('iv', 'value', 'mac', 'tag'), JSON_UNESCAPED_SLASHES));
//
//   CookieValuePrefix::create($cookieName, $key) = hash_hmac('sha1', $cookieName.'v2', $key).'|'
//   EncryptCookies encrypts  CookieValuePrefix::create($name, $key).$value  with $serialize = false.
//
// `$key` is the raw APP_KEY bytes (base64-decoded "base64:..." value).
//
// Only the tests import this file. It is the second implementation the WebCrypto code is checked
// against; PHP itself is not available in this repo's CI.

import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

export function keyBytes(appKey: string): Buffer {
  return appKey.startsWith("base64:") ? Buffer.from(appKey.slice(7), "base64") : Buffer.from(appKey, "utf8");
}

function phpSerializeString(s: string): string {
  return `s:${Buffer.byteLength(s)}:"${s}";`;
}

export function refEncrypt(
  plain: string,
  appKey: string,
  iv: Buffer,
  opts: { serialize?: boolean; cipher?: "aes-256-cbc" | "aes-128-cbc" | "aes-256-gcm"; escapeSlashes?: boolean } = {},
): string {
  const key = keyBytes(appKey);
  const cipher = opts.cipher ?? "aes-256-cbc";
  const data = opts.serialize === false ? plain : phpSerializeString(plain);
  let value: string;
  let tag = "";
  if (cipher === "aes-256-gcm") {
    const c = createCipheriv(cipher, key, iv);
    value = Buffer.concat([c.update(data, "utf8"), c.final()]).toString("base64");
    tag = c.getAuthTag().toString("base64");
  } else {
    const c = createCipheriv(cipher, key, iv);
    value = Buffer.concat([c.update(data, "utf8"), c.final()]).toString("base64");
  }
  const ivB64 = iv.toString("base64");
  const mac = cipher === "aes-256-gcm" ? "" : createHmac("sha256", key).update(ivB64 + value).digest("hex");
  let json = JSON.stringify({ iv: ivB64, value, mac, tag });
  // Laravel < 9 called json_encode without JSON_UNESCAPED_SLASHES.
  if (opts.escapeSlashes) json = json.replace(/\//g, "\\/");
  return Buffer.from(json).toString("base64");
}

/** Laravel's decrypt(): verifies the MAC (hash_equals), then openssl_decrypt. Returns the raw plaintext. */
export function refDecrypt(payload: string, appKey: string, cipher: "aes-256-cbc" | "aes-128-cbc" | "aes-256-gcm" = "aes-256-cbc"): string {
  const key = keyBytes(appKey);
  const p = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  if (cipher !== "aes-256-gcm") {
    const mac = createHmac("sha256", key).update(p.iv + p.value).digest("hex");
    if (mac !== p.mac) throw new Error("The MAC is invalid.");
  }
  const d = createDecipheriv(cipher, key, Buffer.from(p.iv, "base64"));
  if (cipher === "aes-256-gcm") (d as any).setAuthTag(Buffer.from(p.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(p.value, "base64")), d.final()]).toString("utf8");
}

export function refCookiePrefix(cookieName: string, appKey: string): string {
  return createHmac("sha1", keyBytes(appKey)).update(cookieName + "v2").digest("hex") + "|";
}

/** 'login_' . $guardName . '_' . sha1(SessionGuard::class) */
export function refLoginKey(guard = "web"): string {
  return `login_${guard}_${createHash("sha1").update("Illuminate\\Auth\\SessionGuard").digest("hex")}`;
}
