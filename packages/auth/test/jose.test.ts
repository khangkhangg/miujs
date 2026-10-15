import { describe, expect, test } from "bun:test";
import { base64urlDecode, base64urlEncode, utf8 } from "@miujs/session";
import { decodeJwt, derToRawSignature, importEs256PrivateKey, signJwt, verifyJws } from "../src/jose.ts";

const ec = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const rsa = () =>
  crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const pub = async (k: CryptoKeyPair, kid: string) => ({ ...(await crypto.subtle.exportKey("jwk", k.publicKey)), kid });
const json = (v: unknown) => base64urlEncode(utf8(JSON.stringify(v)));

async function rsaToken(k: CryptoKeyPair, header: Record<string, unknown>, payload: unknown) {
  const input = `${json(header)}.${json(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.privateKey, utf8(input)));
  return `${input}.${base64urlEncode(sig)}`;
}

/** Raw r||s → ASN.1 DER, as authenticators send ES256 signatures. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

describe("verifyJws", () => {
  test("RS256 and ES256 tokens verify against the matching JWK by kid", async () => {
    const r = await rsa();
    const e = await ec();
    const keys = [await pub(r, "r1"), await pub(e, "e1")];
    const resolve = async (h: { kid?: string }) => keys.find((k) => k.kid === h.kid) ?? null;
    const rt = await rsaToken(r, { alg: "RS256", kid: "r1" }, { sub: "a" });
    expect((await verifyJws(rt, resolve)).payload).toEqual({ sub: "a" });
    const et = await signJwt({ sub: "b" }, { kid: "e1" }, e.privateKey);
    expect((await verifyJws(et, resolve)).payload).toEqual({ sub: "b" });
  });

  test("a tampered payload, wrong key or unknown kid is rejected", async () => {
    const e = await ec();
    const other = await ec();
    const good = await pub(e, "k");
    const token = await signJwt({ sub: "a", admin: false }, { kid: "k" }, e.privateKey);
    const [h, , s] = token.split(".");
    await expect(verifyJws(`${h}.${json({ sub: "a", admin: true })}.${s}`, async () => good)).rejects.toThrow();
    await expect(verifyJws(token, async () => pub(other, "k"))).rejects.toThrow();
    await expect(verifyJws(token, async () => null)).rejects.toThrow();
  });

  test("alg none, HS256 and alg/key-type confusion are rejected", async () => {
    const r = await rsa();
    const e = await ec();
    const rk = await pub(r, "k");
    const ek = await pub(e, "k");
    await expect(verifyJws(`${json({ alg: "none" })}.${json({ sub: "a" })}.`, async () => rk)).rejects.toThrow();
    await expect(verifyJws(`${json({ alg: "HS256", kid: "k" })}.${json({ sub: "a" })}.${base64urlEncode(new Uint8Array(32))}`, async () => rk)).rejects.toThrow();
    // An ES256 token presented as RS256 (and vice versa) must not verify against the other key type.
    const et = await signJwt({ sub: "a" }, { kid: "k" }, e.privateKey);
    const [, p, s] = et.split(".");
    await expect(verifyJws(`${json({ alg: "RS256", kid: "k" })}.${p}.${s}`, async () => ek)).rejects.toThrow();
    const rt = await rsaToken(r, { alg: "ES256", kid: "k" }, { sub: "a" });
    await expect(verifyJws(rt, async () => rk)).rejects.toThrow();
    // A key that declares a different alg is not used.
    await expect(verifyJws(et, async () => ({ ...ek, alg: "ES384" }))).rejects.toThrow();
  });

  test("malformed tokens are rejected", async () => {
    const e = await ec();
    const k = await pub(e, "k");
    for (const bad of ["", "a.b", "a.b.c.d", "!!.!!.!!", `${json({ alg: "ES256" })}.notjson.${base64urlEncode(new Uint8Array(64))}`]) {
      await expect(verifyJws(bad, async () => k)).rejects.toThrow();
    }
  });
});

describe("signJwt / importEs256PrivateKey", () => {
  test("signs ES256 JWTs from a PKCS#8 PEM (Apple .p8 key)", async () => {
    const e = await ec();
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", e.privateKey));
    const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
    const key = await importEs256PrivateKey(pem);
    const token = await signJwt({ iss: "TEAM" }, { kid: "KEY1" }, key);
    const { header, payload } = decodeJwt(token);
    expect(header).toEqual({ alg: "ES256", kid: "KEY1", typ: "JWT" });
    expect(payload).toEqual({ iss: "TEAM" });
    expect(base64urlDecode(token.split(".")[2])!.length).toBe(64);
    expect((await verifyJws(token, async () => pub(e, "KEY1"))).payload).toEqual({ iss: "TEAM" });
  });

  test("a bad PEM is a clear error", async () => {
    await expect(importEs256PrivateKey("not a key")).rejects.toThrow();
  });
});

describe("derToRawSignature", () => {
  test("converts DER ECDSA signatures to the 64-byte form WebCrypto verifies", async () => {
    const e = await ec();
    for (let i = 0; i < 20; i++) {
      const data = utf8(`msg ${i}`);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, e.privateKey, data));
      const back = derToRawSignature(rawToDer(raw));
      expect(back).toEqual(raw);
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, e.publicKey, back! as Uint8Array<ArrayBuffer>, data)).toBe(true);
    }
  });

  test("malformed DER returns null", () => {
    for (const bad of [[], [0x30], [0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01], [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x05, 0x01], [0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00]]) {
      expect(derToRawSignature(new Uint8Array(bad))).toBeNull();
    }
    const tooLong = [0x30, 0x26, 0x02, 0x21, ...new Array(33).fill(0x7f), 0x02, 0x01, 0x01];
    expect(derToRawSignature(new Uint8Array(tooLong))).toBeNull();
  });
});
