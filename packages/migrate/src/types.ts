import type { Context } from "miujs";

/** The old framework's session, as read from its cookie and store. */
export interface LegacySession {
  kind: "laravel" | "django";
  /** Session id (Laravel: 40 alphanumerics; Django: the `session_key`). */
  id: string;
  /** Decoded session data. */
  data: Record<string, unknown>;
  /** The logged-in user's id as a string, or null when the session has no user. */
  userId: string | null;
}

/** Reads (and for login/logout, writes) the old app's session so both apps share one login. */
export interface LegacySessionSource {
  readonly kind: "laravel" | "django";
  /** The old app's session on this request, or null (no cookie, bad signature, expired, unreadable). Cached per request. */
  read(ctx: Context): Promise<LegacySession | null>;
  /** Signs `userId` in for the old app too: writes its store and sets its cookie on this response. */
  login(ctx: Context, userId: string | number, opts?: Record<string, unknown>): Promise<LegacySession>;
  /** Removes the old app's session and expires its cookie. */
  logout(ctx: Context): Promise<void>;
  /** Safe to print: never contains keys. */
  inspect(): Record<string, unknown>;
}

export interface LegacyCookieOptions {
  path?: string;
  domain?: string;
  /** Default: true on https requests. */
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}
