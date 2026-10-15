// A software authenticator for tests: real ES256 / RS256 keys from crypto.subtle, real CBOR.

import { base64urlDecode, base64urlEncode, utf8 } from "@miujs/session";

type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor) => {
    if (typeof x === "number") out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === "string") {
      const b = utf8(x);
      out.push(...head(3, b.length), ...b);
    } else if (typeof x === "boolean") out.push(x ? 0xf5 : 0xf4);
    else if (x === null) out.push(0xf6);
    else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(enc);
    } else if (x instanceof Map) {
      out.push(...head(5, x.size));
      for (const [k, val] of x) (enc(k), enc(val));
    } else {
      const entries = Object.entries(x);
      out.push(...head(5, entries.length));
      for (const [k, val] of entries) (enc(k), enc(val));
    }
  };
  enc(v);
  return new Uint8Array(out);
}

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) (out.set(p, i), (i += p.length));
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const b64 = (b: Uint8Array) => base64urlEncode(b);

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export const FLAGS = { UP: 0x01, UV: 0x04, AT: 0x40, ED: 0x80 };

export interface CreateOverrides {
  origin?: string;
  type?: string;
  challenge?: string;
  crossOrigin?: boolean;
  rpId?: string;
  flags?: number;
  fmt?: string;
  attStmt?: Cbor;
  coseKey?: Map<Cbor, Cbor>;
  /** Credential id inside authData (default: the real one). */
  authDataCredId?: Uint8Array;
  transports?: string[];
}

export interface GetOverrides {
  origin?: string;
  type?: string;
  challenge?: string;
  crossOrigin?: boolean;
  rpId?: string;
  flags?: number;
  signCount?: number;
  userHandle?: string | null;
  /** Sign with another key. */
  signWith?: CryptoKey;
  /** Change clientDataJSON after signing. */
  tamperClientData?: boolean;
  credentialId?: string;
}

export class SoftAuthenticator {
  credId = crypto.getRandomValues(new Uint8Array(16));
  signCount = 0;
  /** Bump the counter on each get (false = always 0, like many platform passkeys). */
  counting = true;
  keys!: CryptoKeyPair;
  userHandle: string | null = null;

  readonly alg: -7 | -257;
  constructor(alg: -7 | -257 = -7) {
    this.alg = alg;
  }

  async init() {
    this.keys =
      this.alg === -7
        ? ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair)
        : ((await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair);
    return this;
  }

  get id() {
    return b64(this.credId);
  }

  async coseKey(): Promise<Map<Cbor, Cbor>> {
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    if (this.alg === -7) return new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, base64urlDecode(jwk.x!)!], [-3, base64urlDecode(jwk.y!)!]]);
    return new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, base64urlDecode(jwk.n!)!], [-2, base64urlDecode(jwk.e!)!]]);
  }

  /** navigator.credentials.create() → RegistrationResponseJSON */
  async create(options: { challenge: string; rp: { id: string }; user: { id: string } }, origin: string, o: CreateOverrides = {}) {
    this.userHandle = options.user.id;
    const clientData = utf8(JSON.stringify({ type: o.type ?? "webauthn.create", challenge: o.challenge ?? options.challenge, origin: o.origin ?? origin, crossOrigin: o.crossOrigin ?? false }));
    const credId = o.authDataCredId ?? this.credId;
    const authData = concat(
      await sha256(utf8(o.rpId ?? options.rp.id)),
      new Uint8Array([o.flags ?? FLAGS.UP | FLAGS.UV | FLAGS.AT]),
      u32(0),
      new Uint8Array(16),
      new Uint8Array([credId.length >> 8, credId.length & 0xff]),
      credId,
      cbor(o.coseKey ?? (await this.coseKey())),
    );
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", o.fmt ?? "none"], ["attStmt", o.attStmt ?? new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: o.transports ?? ["internal", "hybrid"] },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() → AuthenticationResponseJSON */
  async get(options: { challenge: string; rpId: string }, origin: string, o: GetOverrides = {}) {
    if (o.signCount !== undefined) this.signCount = o.signCount;
    else if (this.counting) this.signCount++;
    let clientData = utf8(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: o.challenge ?? options.challenge, origin: o.origin ?? origin, crossOrigin: o.crossOrigin ?? false }));
    const authData = concat(await sha256(utf8(o.rpId ?? options.rpId)), new Uint8Array([o.flags ?? FLAGS.UP | FLAGS.UV]), u32(this.signCount));
    const data = concat(authData, await sha256(clientData));
    const key = o.signWith ?? this.keys.privateKey;
    let sig: Uint8Array;
    if (this.alg === -7) sig = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as Uint8Array<ArrayBuffer>)));
    else sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data as Uint8Array<ArrayBuffer>));
    if (o.tamperClientData) clientData = utf8(new TextDecoder().decode(clientData).replace("webauthn.get", "webauthn.get ".trim()) + " ");
    const id = o.credentialId ?? this.id;
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(sig), userHandle: o.userHandle === undefined ? this.userHandle : o.userHandle },
      clientExtensionResults: {},
    };
  }
}
