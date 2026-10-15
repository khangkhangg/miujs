// Minimal MessagePack (https://msgpack.org) for the optional binary wire encoding. Covers the
// JSON data model plus byte arrays: nil, bool, int, float64, str, bin, array, map. Dependency-free
// so the browser client can share it. Integers outside ±2^53 are encoded as float64.

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

class Writer {
  buf: Uint8Array<ArrayBuffer> = new Uint8Array(64);
  view = new DataView(this.buf.buffer);
  len = 0;

  ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(x: number): void {
    this.ensure(1);
    this.buf[this.len++] = x;
  }
  head(tag: number, size: number, put: (v: DataView, at: number) => void): void {
    this.ensure(1 + size);
    this.buf[this.len] = tag;
    put(this.view, this.len + 1);
    this.len += 1 + size;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
}

function writeLen(w: Writer, n: number, fix: number | null, fixMax: number, t8: number | null, t16: number, t32: number): void {
  if (fix !== null && n <= fixMax) w.u8(fix | n);
  else if (t8 !== null && n < 0x100) w.head(t8, 1, (v, at) => v.setUint8(at, n));
  else if (n < 0x10000) w.head(t16, 2, (v, at) => v.setUint16(at, n));
  else w.head(t32, 4, (v, at) => v.setUint32(at, n));
}

function writeNumber(w: Writer, x: number): void {
  if (!Number.isSafeInteger(x)) return w.head(0xcb, 8, (v, at) => v.setFloat64(at, x));
  if (x >= 0) {
    if (x < 0x80) w.u8(x);
    else if (x < 0x100) w.head(0xcc, 1, (v, at) => v.setUint8(at, x));
    else if (x < 0x10000) w.head(0xcd, 2, (v, at) => v.setUint16(at, x));
    else if (x < 0x100000000) w.head(0xce, 4, (v, at) => v.setUint32(at, x));
    else w.head(0xcf, 8, (v, at) => v.setBigUint64(at, BigInt(x)));
  } else {
    if (x >= -32) w.u8(x & 0xff);
    else if (x >= -0x80) w.head(0xd0, 1, (v, at) => v.setInt8(at, x));
    else if (x >= -0x8000) w.head(0xd1, 2, (v, at) => v.setInt16(at, x));
    else if (x >= -0x80000000) w.head(0xd2, 4, (v, at) => v.setInt32(at, x));
    else w.head(0xd3, 8, (v, at) => v.setBigInt64(at, BigInt(x)));
  }
}

function write(w: Writer, x: unknown): void {
  if (x === null || x === undefined) return w.u8(0xc0);
  switch (typeof x) {
    case "boolean":
      return w.u8(x ? 0xc3 : 0xc2);
    case "number":
      return writeNumber(w, x);
    case "string": {
      const b = enc.encode(x);
      writeLen(w, b.length, 0xa0, 31, 0xd9, 0xda, 0xdb);
      return w.bytes(b);
    }
    case "object": {
      if (x instanceof Uint8Array) {
        writeLen(w, x.length, null, 0, 0xc4, 0xc5, 0xc6);
        return w.bytes(x);
      }
      if (Array.isArray(x)) {
        writeLen(w, x.length, 0x90, 15, null, 0xdc, 0xdd);
        for (const v of x) write(w, v);
        return;
      }
      const keys = Object.keys(x).filter((k) => (x as Record<string, unknown>)[k] !== undefined);
      writeLen(w, keys.length, 0x80, 15, null, 0xde, 0xdf);
      for (const k of keys) {
        write(w, k);
        write(w, (x as Record<string, unknown>)[k]);
      }
      return;
    }
    default:
      throw new TypeError(`MessagePack cannot encode a ${typeof x}`);
  }
}

/** Encode a JSON-like value (plus `Uint8Array`) as MessagePack. */
export function encode(value: unknown): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  write(w, value);
  return w.buf.slice(0, w.len);
}

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  readonly view: DataView;
  constructor(buf: Uint8Array, view: DataView) {
    this.buf = buf;
    this.view = view;
  }

  need(n: number): number {
    if (this.pos + n > this.buf.length) throw new RangeError("MessagePack data is truncated");
    const at = this.pos;
    this.pos += n;
    return at;
  }
}

function readStr(r: Reader, n: number): string {
  const at = r.need(n);
  return dec.decode(r.buf.subarray(at, at + n));
}

function readArray(r: Reader, n: number): unknown[] {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = read(r);
  return out;
}

function readMap(r: Reader, n: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const k = read(r);
    if (typeof k !== "string" && typeof k !== "number") throw new TypeError("MessagePack map keys must be strings or numbers");
    // defineProperty so a "__proto__" key stays plain data.
    Object.defineProperty(out, String(k), { value: read(r), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function read(r: Reader): unknown {
  const b = r.buf[r.need(1)];
  if (b < 0x80) return b;
  if (b >= 0xe0) return b - 0x100;
  if ((b & 0xf0) === 0x80) return readMap(r, b & 0x0f);
  if ((b & 0xf0) === 0x90) return readArray(r, b & 0x0f);
  if ((b & 0xe0) === 0xa0) return readStr(r, b & 0x1f);
  const v = r.view;
  switch (b) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
    case 0xc5:
    case 0xc6: {
      const n = b === 0xc4 ? v.getUint8(r.need(1)) : b === 0xc5 ? v.getUint16(r.need(2)) : v.getUint32(r.need(4));
      const at = r.need(n);
      return r.buf.slice(at, at + n);
    }
    case 0xca:
      return v.getFloat32(r.need(4));
    case 0xcb:
      return v.getFloat64(r.need(8));
    case 0xcc:
      return v.getUint8(r.need(1));
    case 0xcd:
      return v.getUint16(r.need(2));
    case 0xce:
      return v.getUint32(r.need(4));
    case 0xcf:
      return Number(v.getBigUint64(r.need(8)));
    case 0xd0:
      return v.getInt8(r.need(1));
    case 0xd1:
      return v.getInt16(r.need(2));
    case 0xd2:
      return v.getInt32(r.need(4));
    case 0xd3:
      return Number(v.getBigInt64(r.need(8)));
    case 0xd9:
      return readStr(r, v.getUint8(r.need(1)));
    case 0xda:
      return readStr(r, v.getUint16(r.need(2)));
    case 0xdb:
      return readStr(r, v.getUint32(r.need(4)));
    case 0xdc:
      return readArray(r, v.getUint16(r.need(2)));
    case 0xdd:
      return readArray(r, v.getUint32(r.need(4)));
    case 0xde:
      return readMap(r, v.getUint16(r.need(2)));
    case 0xdf:
      return readMap(r, v.getUint32(r.need(4)));
    default:
      throw new TypeError(`Unsupported MessagePack type byte 0x${b.toString(16)}`);
  }
}

/** Decode one MessagePack value. Throws on malformed, truncated or trailing data. */
export function decode(data: Uint8Array | ArrayBuffer): unknown {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const r = new Reader(buf, new DataView(buf.buffer, buf.byteOffset, buf.byteLength));
  const value = read(r);
  if (r.pos !== buf.length) throw new RangeError("Trailing bytes after MessagePack value");
  return value;
}
