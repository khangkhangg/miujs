import { errors } from "./errors.ts";

// RFC 6265 cookie-octet: printable ASCII except space, DQUOTE, comma, semicolon and backslash.
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /**
   * URL-encode the value (default true). Set false to send it as is, e.g. for cookies another
   * framework reads without decoding (Django). Raw values must be RFC 6265 cookie-octets.
   */
  encode?: boolean;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  if (opts.encode === false && !COOKIE_OCTETS.test(value)) {
    throw errors.config(
      "MIU_E_COOKIE_VALUE_INVALID",
      `Cookie "${name}" has characters not allowed in a raw cookie value`,
      "Use only printable ASCII without spaces, quotes, commas, semicolons or backslashes, or leave encode on.",
    );
  }
  let s = `${name}=${opts.encode === false ? value : encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.expires) s += `; Expires=${opts.expires.toUTCString()}`;
  s += `; Path=${opts.path ?? "/"}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  if (opts.secure) s += "; Secure";
  if (opts.httpOnly ?? true) s += "; HttpOnly";
  s += `; SameSite=${opts.sameSite ?? "Lax"}`;
  return s;
}

export interface Cookies {
  get(name: string): string | undefined;
  all(): Record<string, string>;
  set(name: string, value: string, opts?: CookieOptions): void;
  delete(name: string, opts?: Pick<CookieOptions, "path" | "domain">): void;
}
