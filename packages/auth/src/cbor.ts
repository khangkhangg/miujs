// Minimal strict CBOR decoder (RFC 8949) for WebAuthn: attestation objects and COSE keys.
// Definite lengths only (CTAP2 canonical form), maps → Map, tags unwrapped. Throws on anything malformed.

export type CborValue = number | bigint | string | boolean | null | undefined | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

const MAX_DEPTH = 16;
const utf8 = new TextDecoder("utf-8", { fatal: true });

class Reader {
  pos = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  need(n: number) {
    if (n < 0 || this.pos + n > this.b.length) throw new Error("CBOR: unexpected end of input");
  }
  u8(): number {
    this.need(1);
    return this.b[this.pos++];
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  uint(n: number): number {
    this.need(n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.b[this.pos++];
    if (!Number.isSafeInteger(v)) throw new Error("CBOR: integer too large");
    return v;
  }
}

function half(bits: number): number {
  const exp = (bits >> 10) & 0x1f;
  const mant = bits & 0x3ff;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

function item(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new Error("CBOR: nested too deeply");
  const first = r.u8();
  const major = first >> 5;
  const info = first & 0x1f;
  if (major === 7) {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25:
        return half(r.uint(2));
      case 26: {
        const v = new DataView(r.bytes(4).buffer).getFloat32(0);
        return v;
      }
      case 27:
        return new DataView(r.bytes(8).buffer).getFloat64(0);
      default:
        throw new Error("CBOR: unsupported simple value");
    }
  }
  let arg: number;
  if (info < 24) arg = info;
  else if (info === 24) arg = r.uint(1);
  else if (info === 25) arg = r.uint(2);
  else if (info === 26) arg = r.uint(4);
  else if (info === 27) arg = r.uint(8);
  else throw new Error(info === 31 ? "CBOR: indefinite lengths are not supported" : "CBOR: reserved additional info");
  switch (major) {
    case 0:
      return arg;
    case 1:
      return -1 - arg;
    case 2:
      return r.bytes(arg);
    case 3:
      return utf8.decode(r.bytes(arg));
    case 4: {
      r.need(arg); // each item is at least one byte: refuse absurd lengths before allocating
      const out: CborValue[] = [];
      for (let i = 0; i < arg; i++) out.push(item(r, depth + 1));
      return out;
    }
    case 5: {
      r.need(arg * 2);
      const out = new Map<CborValue, CborValue>();
      for (let i = 0; i < arg; i++) {
        const k = item(r, depth + 1);
        if (k !== null && typeof k === "object") throw new Error("CBOR: map keys must be scalars");
        if (out.has(k)) throw new Error("CBOR: duplicate map key");
        out.set(k, item(r, depth + 1));
      }
      return out;
    }
    case 6:
      return item(r, depth + 1);
    default:
      throw new Error("CBOR: bad major type");
  }
}

/** Decodes the first CBOR item and reports how many bytes it used (authenticator data has more after it). */
export function decodeCborPrefix(bytes: Uint8Array): { value: CborValue; length: number } {
  const r = new Reader(bytes);
  const value = item(r, 0);
  return { value, length: r.pos };
}

/** Decodes exactly one CBOR item; trailing bytes are an error. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, length } = decodeCborPrefix(bytes);
  if (length !== bytes.length) throw new Error("CBOR: trailing bytes");
  return value;
}
