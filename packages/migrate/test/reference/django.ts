// Independent reference implementation of django.core.signing (Django 3.1–5.x), written with
// node:crypto and node:zlib from the Python source, for tests only:
//
//   salted_hmac(key_salt, value, secret, algorithm):
//       key = hashlib.<algorithm>(key_salt + secret).digest()
//       return hmac.new(key, msg=value, digestmod=hashlib.<algorithm>)
//   Signer.signature(value) = urlsafe_b64encode(salted_hmac(salt + "signer", value, SECRET_KEY, algorithm="sha256").digest()).strip("=")
//   Signer.sign(value)      = value + ":" + signature(value)
//   TimestampSigner.sign(v) = Signer.sign(v + ":" + b62_encode(int(time.time())))
//   dumps(obj, salt, compress):
//       data = json.dumps(obj, separators=(",", ":")).encode("latin-1")       # ensure_ascii=True
//       if compress: c = zlib.compress(data); if len(c) < len(data) - 1: data = c; compressed = True
//       b64 = urlsafe_b64encode(data).strip("=");  if compressed: b64 = "." + b64
//       return TimestampSigner(salt=salt).sign(b64)
//
// Django's DB session backend calls dumps(session_dict, salt="django.contrib.sessions.SessionStore", compress=True).

import { createHash, createHmac } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function b62Encode(n: number): string {
  if (n === 0) return "0";
  let s = "";
  while (n > 0) {
    s = B62[n % 62] + s;
    n = Math.floor(n / 62);
  }
  return s;
}

function b64(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function refSaltedHmac(keySalt: string, value: string, secret: string, algorithm: "sha1" | "sha256" = "sha256"): Buffer {
  const key = createHash(algorithm).update(keySalt + secret).digest();
  return createHmac(algorithm, key).update(value).digest();
}

function pyJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function refDumps(obj: unknown, secret: string, opts: { salt?: string; compress?: boolean; timestamp?: number; algorithm?: "sha1" | "sha256" } = {}): string {
  const salt = opts.salt ?? "django.core.signing";
  let data = Buffer.from(pyJson(obj), "latin1");
  let compressed = false;
  if (opts.compress) {
    const c = deflateSync(data);
    if (c.length < data.length - 1) {
      data = c;
      compressed = true;
    }
  }
  let value = b64(data);
  if (compressed) value = "." + value;
  value = `${value}:${b62Encode(opts.timestamp ?? Math.floor(Date.now() / 1000))}`;
  return `${value}:${b64(refSaltedHmac(salt + "signer", value, secret, opts.algorithm))}`;
}

export function refLoads(signed: string, secret: string, salt = "django.core.signing"): unknown {
  const i = signed.lastIndexOf(":");
  const value = signed.slice(0, i);
  if (signed.slice(i + 1) !== b64(refSaltedHmac(salt + "signer", value, secret))) throw new Error("BadSignature");
  let body = value.slice(0, value.lastIndexOf(":"));
  const compressed = body.startsWith(".");
  if (compressed) body = body.slice(1);
  let data = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (compressed) data = inflateSync(data);
  return JSON.parse(data.toString("latin1"));
}

/** AbstractBaseUser.get_session_auth_hash(): salted_hmac(key_salt, self.password, algorithm="sha256").hexdigest() */
export function refSessionAuthHash(passwordHash: string, secret: string): string {
  return refSaltedHmac("django.contrib.auth.models.AbstractBaseUser.get_session_auth_hash", passwordHash, secret).toString("hex");
}
