export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
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
  let s = `${name}=${encodeURIComponent(value)}`;
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
