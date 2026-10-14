import type { Middleware } from "../core/app.ts";

/**
 * Read PHP's `serialize()` format and native session files, so a Miu app can
 * share logins with a PHP app during an incremental migration.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A PHP object: its public, protected and private properties plus `__class`. */
export type PhpObject = { __class: string } & Record<string, unknown>;

/**
 * Parse a PHP `serialize()` string. Arrays with keys 0..n-1 become JS arrays,
 * other arrays become objects; objects become plain objects with `__class`.
 * Throws on malformed input.
 */
export function unserializePhp(input: string): unknown {
  const p = new Parser(enc.encode(input));
  const v = p.value();
  if (p.pos !== p.buf.length) p.fail("trailing data");
  return v;
}

/** Serialize a JS value the way PHP's `serialize()` would (objects become associative arrays). */
export function serializePhp(value: unknown): string {
  if (value === null || value === undefined) return "N;";
  if (typeof value === "boolean") return `b:${value ? 1 : 0};`;
  if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return `i:${value};`;
    if (Number.isNaN(value)) return "d:NAN;";
    if (!Number.isFinite(value)) return value > 0 ? "d:INF;" : "d:-INF;";
    return `d:${value};`;
  }
  if (typeof value === "bigint") return `i:${value};`;
  if (typeof value === "string") return `s:${enc.encode(value).length}:"${value}";`;
  if (value instanceof Date) return serializePhp(value.toISOString());
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value as object).map(([k, v]) => [/^(0|-?[1-9]\d*)$/.test(k) ? Number(k) : k, v]);
  return `a:${entries.length}:{${entries.map(([k, v]) => serializePhp(k) + serializePhp(v)).join("")}}`;
}

export type PhpSessionHandler = "php" | "php_serialize";

/**
 * Decode raw session data as written by PHP's session module. Supports the
 * default `php` handler (`key|<serialized>key2|…`) and `php_serialize` (one
 * serialized array). The handler is auto-detected unless given.
 */
export function decodePhpSession(data: string, handler?: PhpSessionHandler): Record<string, unknown> {
  if (!data) return {};
  if (handler === "php_serialize" || (!handler && /^a:\d+:\{/.test(data))) {
    try {
      const v = unserializePhp(data);
      if (typeof v === "object" && v !== null) return { ...(v as object) };
      throw new Error("php_serialize session is not an array");
    } catch (err) {
      if (handler) throw err;
    }
  }
  const p = new Parser(enc.encode(data));
  const out: Record<string, unknown> = {};
  while (p.pos < p.buf.length) {
    const bar = p.buf.indexOf(0x7c, p.pos); // "|"
    if (bar < 0) p.fail("expected '|'");
    let key = dec.decode(p.buf.subarray(p.pos, bar));
    p.pos = bar + 1;
    const undef = key.startsWith("!"); // PHP_SESSION_UNDEF marker (old PHP)
    if (undef) key = key.slice(1);
    else out[key] = p.value();
  }
  return out;
}

export interface PhpSessionBridgeOptions {
  /** Default `PHPSESSID`. Laravel apps use their own name (and encrypted cookies; decrypt in `read`). */
  cookieName?: string;
  /** Load raw session data by id: from files (`sess_<id>`), Redis, Memcached or a database table. */
  read: (id: string) => Promise<string | undefined | null>;
  handler?: PhpSessionHandler;
  /** Context variable to set. Default `legacySession`. */
  variable?: string;
}

/**
 * Middleware exposing a PHP app's session as read-only data via
 * `c.get("legacySession")`. Undefined when there is no cookie or session.
 */
export function phpSessionBridge(opts: PhpSessionBridgeOptions): Middleware {
  const name = opts.cookieName ?? "PHPSESSID";
  const variable = opts.variable ?? "legacySession";
  return async (c, next) => {
    const id = c.cookie(name);
    // PHP session ids only use [A-Za-z0-9,-]; reject anything else before it reaches `read`.
    if (id && /^[A-Za-z0-9,-]{1,256}$/.test(id)) {
      const raw = await opts.read(id);
      if (raw) c.set(variable, Object.freeze(decodePhpSession(raw, opts.handler)));
    }
    await next();
  };
}

class Parser {
  buf: Uint8Array;
  pos = 0;
  private refs: unknown[] = [];

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  fail(msg: string): never {
    throw new SyntaxError(`Invalid PHP serialized data at byte ${this.pos}: ${msg}`);
  }

  private expect(ch: string): void {
    if (this.buf[this.pos] !== ch.charCodeAt(0)) this.fail(`expected '${ch}'`);
    this.pos++;
  }

  private until(ch: string): string {
    const end = this.buf.indexOf(ch.charCodeAt(0), this.pos);
    if (end < 0) this.fail(`expected '${ch}'`);
    const s = dec.decode(this.buf.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }

  private int(term: string): number {
    const s = this.until(term);
    if (!/^[+-]?\d+$/.test(s)) this.fail(`bad integer ${JSON.stringify(s)}`);
    return Number(s);
  }

  private str(): string {
    const len = this.int(":");
    this.expect('"');
    if (this.pos + len > this.buf.length) this.fail("string length out of range");
    const s = dec.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    this.expect('"');
    return s;
  }

  value(): unknown {
    const type = String.fromCharCode(this.buf[this.pos] ?? 0);
    this.pos++;
    if (type === "N") {
      this.expect(";");
      return this.push(null);
    }
    this.expect(":");
    switch (type) {
      case "b": {
        const n = this.int(";");
        return this.push(n !== 0);
      }
      case "i":
        return this.push(this.int(";"));
      case "d": {
        const s = this.until(";");
        const n = s === "INF" ? Infinity : s === "-INF" ? -Infinity : s === "NAN" ? NaN : Number(s);
        if (Number.isNaN(n) && s !== "NAN") this.fail(`bad float ${JSON.stringify(s)}`);
        return this.push(n);
      }
      case "s":
      case "E": {
        const s = this.str();
        this.expect(";");
        return this.push(s);
      }
      case "r":
      case "R": {
        const i = this.int(";");
        if (i < 1 || i > this.refs.length) this.fail("bad reference");
        return this.refs[i - 1];
      }
      case "a": {
        const slot = this.reserve();
        const n = this.int(":");
        this.expect("{");
        const keys: (string | number)[] = [];
        const vals: unknown[] = [];
        for (let i = 0; i < n; i++) {
          keys.push(this.key());
          vals.push(this.value());
        }
        this.expect("}");
        const isList = keys.every((k, i) => k === i);
        const out: unknown = isList ? vals : Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
        this.refs[slot] = out;
        return out;
      }
      case "O": {
        const slot = this.reserve();
        const cls = this.str();
        this.expect(":");
        const n = this.int(":");
        this.expect("{");
        const out: PhpObject = { __class: cls };
        this.refs[slot] = out;
        for (let i = 0; i < n; i++) {
          // Protected props are "\0*\0name", private ones "\0Class\0name".
          const k = String(this.key()).replace(/^\0[^\0]*\0/, "");
          out[k] = this.value();
        }
        this.expect("}");
        return out;
      }
      case "C": {
        // Custom-serialized (Serializable) objects: keep the raw payload.
        const cls = this.str();
        this.expect(":");
        const len = this.int(":");
        this.expect("{");
        const data = dec.decode(this.buf.subarray(this.pos, this.pos + len));
        this.pos += len;
        this.expect("}");
        return this.push({ __class: cls, __serialized: data });
      }
      default:
        this.pos--;
        return this.fail(`unknown type '${type}'`);
    }
  }

  /** Array/object keys: `i:n;` or `s:len:"…";`. Keys do not occupy reference slots. */
  private key(): string | number {
    const type = String.fromCharCode(this.buf[this.pos] ?? 0);
    this.pos++;
    this.expect(":");
    if (type === "i") return this.int(";");
    if (type === "s") {
      const s = this.str();
      this.expect(";");
      return s;
    }
    return this.fail("bad array key");
  }

  private reserve(): number {
    this.refs.push(undefined);
    return this.refs.length - 1;
  }

  private push<T>(v: T): T {
    this.refs.push(v);
    return v;
  }
}
