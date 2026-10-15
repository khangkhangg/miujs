// Minimal MessagePack (https://msgpack.org) for the optional binary wire encoding. Covers the
// JSON data model plus byte arrays: nil, bool, int, float64, str, bin, array, map. Dependency-free
// so the browser client can share it. Integers outside ±2^53 are encoded as float64.

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** Strings up to this many UTF-16 units are tried as ASCII by hand before TextEncoder/Decoder. */
const SHORT = 64;
/** A scratch buffer larger than this is not kept between encode() calls. */
const KEEP_MAX = 64 * 1024;

class Writer {
  buf: Uint8Array<ArrayBuffer> = new Uint8Array(256);
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
  u8u8(tag: number, x: number): void {
    this.ensure(2);
    this.buf[this.len++] = tag;
    this.buf[this.len++] = x;
  }
  u16(tag: number, x: number): void {
    this.ensure(3);
    this.buf[this.len] = tag;
    this.view.setUint16(this.len + 1, x);
    this.len += 3;
  }
  u32(tag: number, x: number): void {
    this.ensure(5);
    this.buf[this.len] = tag;
    this.view.setUint32(this.len + 1, x);
    this.len += 5;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
}

function writeLen(w: Writer, n: number, fix: number | null, fixMax: number, t8: number | null, t16: number, t32: number): void {
  if (fix !== null && n <= fixMax) w.u8(fix | n);
  else if (t8 !== null && n < 0x100) w.u8u8(t8, n);
  else if (n < 0x10000) w.u16(t16, n);
  else w.u32(t32, n);
}

function writeNumber(w: Writer, x: number): void {
  if (!Number.isSafeInteger(x)) {
    w.ensure(9);
    w.buf[w.len] = 0xcb;
    w.view.setFloat64(w.len + 1, x);
    w.len += 9;
    return;
  }
  if (x >= 0) {
    if (x < 0x80) w.u8(x);
    else if (x < 0x100) w.u8u8(0xcc, x);
    else if (x < 0x10000) w.u16(0xcd, x);
    else if (x < 0x100000000) w.u32(0xce, x);
    else {
      w.ensure(9);
      w.buf[w.len] = 0xcf;
      w.view.setBigUint64(w.len + 1, BigInt(x));
      w.len += 9;
    }
  } else {
    if (x >= -32) w.u8(x & 0xff);
    else if (x >= -0x80) w.u8u8(0xd0, x & 0xff);
    else if (x >= -0x8000) w.u16(0xd1, x & 0xffff);
    else if (x >= -0x80000000) w.u32(0xd2, x >>> 0);
    else {
      w.ensure(9);
      w.buf[w.len] = 0xd3;
      w.view.setBigInt64(w.len + 1, BigInt(x));
      w.len += 9;
    }
  }
}

function writeString(w: Writer, s: string): void {
  const n = s.length;
  if (n <= SHORT) {
    let ascii = true;
    for (let i = 0; i < n; i++) {
      if (s.charCodeAt(i) >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      writeLen(w, n, 0xa0, 31, 0xd9, 0xda, 0xdb);
      w.ensure(n);
      const buf = w.buf;
      let at = w.len;
      for (let i = 0; i < n; i++) buf[at++] = s.charCodeAt(i);
      w.len = at;
      return;
    }
  }
  const b = enc.encode(s);
  writeLen(w, b.length, 0xa0, 31, 0xd9, 0xda, 0xdb);
  w.bytes(b);
}

function write(w: Writer, x: unknown): void {
  if (x === null || x === undefined) return w.u8(0xc0);
  switch (typeof x) {
    case "boolean":
      return w.u8(x ? 0xc3 : 0xc2);
    case "number":
      return writeNumber(w, x);
    case "string":
      return writeString(w, x);
    case "object": {
      if (x instanceof Uint8Array) {
        writeLen(w, x.length, null, 0, 0xc4, 0xc5, 0xc6);
        return w.bytes(x);
      }
      if (Array.isArray(x)) {
        writeLen(w, x.length, 0x90, 15, null, 0xdc, 0xdd);
        for (let i = 0; i < x.length; i++) write(w, x[i]);
        return;
      }
      const o = x as Record<string, unknown>;
      const keys = Object.keys(o);
      let n = 0;
      for (let i = 0; i < keys.length; i++) if (o[keys[i]] !== undefined) n++;
      writeLen(w, n, 0x80, 15, null, 0xde, 0xdf);
      for (let i = 0; i < keys.length; i++) {
        const v = o[keys[i]];
        if (v === undefined) continue;
        writeString(w, keys[i]);
        write(w, v);
      }
      return;
    }
    default:
      throw new TypeError(`MessagePack cannot encode a ${typeof x}`);
  }
}

/** Reused between calls (encode is synchronous and not re-entrant), so small frames allocate once. */
let scratch: Writer | null = null;

/** Encode a JSON-like value (plus `Uint8Array`) as MessagePack. */
export function encode(value: unknown): Uint8Array<ArrayBuffer> {
  const w = scratch ?? new Writer();
  scratch = null; // a throw below leaves no half-written writer behind
  w.len = 0;
  write(w, value);
  const out = w.buf.slice(0, w.len);
  if (w.buf.length <= KEEP_MAX) scratch = w;
  return out;
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
  const buf = r.buf;
  if (n <= SHORT) {
    let s = "";
    let i = at;
    const end = at + n;
    for (; i < end; i++) {
      const c = buf[i];
      if (c >= 0x80) break;
      s += String.fromCharCode(c);
    }
    if (i === end) return s;
  }
  return dec.decode(buf.subarray(at, at + n));
}

/** Every element takes at least one byte: a length the remaining bytes cannot hold is a lie (a bomb). */
function checkCount(r: Reader, n: number, perItem: number): void {
  if (n * perItem > r.buf.length - r.pos) throw new RangeError("MessagePack data is truncated");
}

function readArray(r: Reader, n: number): unknown[] {
  checkCount(r, n, 1); // before `new Array(n)`: a 5-byte header must not allocate n slots
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = read(r);
  return out;
}

function readMap(r: Reader, n: number): Record<string, unknown> {
  checkCount(r, n, 2);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const k = read(r);
    if (typeof k !== "string" && typeof k !== "number") throw new TypeError("MessagePack map keys must be strings or numbers");
    const key = String(k);
    const v = read(r);
    // defineProperty so a "__proto__" key stays plain data.
    if (key === "__proto__") Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
    else out[key] = v;
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
