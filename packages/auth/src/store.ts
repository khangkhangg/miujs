import { migrateOnce, resolveDatabase, describeDatabase, type DatabaseSource, type Migration } from "@miujs/db";
import { randomId } from "@miujs/session";
import type { Env } from "miujs";

export interface StoredUser {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  passwordHash: string;
  createdAt: number;
  /** Epoch ms when the user proved they own the email, or null. */
  emailVerifiedAt: number | null;
  /** Bumped on password reset/change. Sessions signed in under an older version are rejected. */
  sessionVersion: number;
}

export type OneTimeTokenPurpose = "verify" | "reset";

/** Emailed single-use tokens (verify email, reset password). Only the SHA-256 hash is stored. */
export interface OneTimeTokenRecord {
  /** Hex SHA-256 of the token. */
  tokenHash: string;
  userId: string;
  purpose: OneTimeTokenPurpose;
  createdAt: number;
  /** Epoch ms. */
  expiresAt: number;
}

export interface NewUser {
  email: string;
  name?: string | null;
  roles: string[];
  passwordHash: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  /** Hex SHA-256 of the token. The token itself is never stored. */
  tokenHash: string;
  createdAt: number;
  /** Epoch ms, or null for no expiry. */
  expiresAt: number | null;
}

/** Where users and API tokens live. Emails are compared lower-cased. */
export interface UserStore {
  readonly kind: string;
  findUserByEmail(email: string, env: Env): Promise<StoredUser | null>;
  findUserById(id: string, env: Env): Promise<StoredUser | null>;
  /** Returns null when the email is taken. */
  createUser(user: NewUser, env: Env): Promise<StoredUser | null>;
  updatePasswordHash(id: string, passwordHash: string, env: Env): Promise<void>;
  createToken(token: ApiTokenRecord, env: Env): Promise<void>;
  findTokenByHash(tokenHash: string, env: Env): Promise<ApiTokenRecord | null>;
  /** Deletes the token only if it belongs to `userId`. */
  deleteToken(id: string, userId: string, env: Env): Promise<boolean>;

  // Needed for email verification and password reset/change (built-in stores have them).
  /** Sets `emailVerifiedAt` unless it is already set. */
  markEmailVerified?(id: string, at: number, env: Env): Promise<void>;
  /** Sets the hash and bumps `sessionVersion` in one step. Returns the new version. */
  changePassword?(id: string, passwordHash: string, env: Env): Promise<number>;
  createOneTimeToken?(token: OneTimeTokenRecord, env: Env): Promise<void>;
  /** Atomically deletes and returns the token if it exists with this purpose (expired or not). */
  consumeOneTimeToken?(tokenHash: string, purpose: OneTimeTokenPurpose, env: Env): Promise<OneTimeTokenRecord | null>;
  deleteOneTimeTokens?(userId: string, purpose: OneTimeTokenPurpose, env: Env): Promise<void>;

  inspect?(): Record<string, unknown>;
  cloudflare?(): { d1?: string[] };
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// ---------------------------------------------------------------------------------------------

/** In-process users. For dev and tests; data is lost on restart. */
export function memoryUserStore(): UserStore {
  const users = new Map<string, StoredUser>();
  const byEmail = new Map<string, string>();
  const tokens = new Map<string, ApiTokenRecord>();
  const oneTime = new Map<string, OneTimeTokenRecord>();
  const clone = <T>(v: T | undefined): T | null => (v === undefined ? null : structuredClone(v));
  return {
    kind: "memory",
    async findUserByEmail(email) {
      const id = byEmail.get(normalizeEmail(email));
      return clone(id ? users.get(id) : undefined);
    },
    async findUserById(id) {
      return clone(users.get(id));
    },
    async createUser(u) {
      const email = normalizeEmail(u.email);
      if (byEmail.has(email)) return null;
      const user: StoredUser = { id: randomId(16), email, name: u.name ?? null, roles: [...u.roles], passwordHash: u.passwordHash, createdAt: Date.now(), emailVerifiedAt: null, sessionVersion: 0 };
      users.set(user.id, user);
      byEmail.set(email, user.id);
      return structuredClone(user);
    },
    async updatePasswordHash(id, hash) {
      const u = users.get(id);
      if (u) u.passwordHash = hash;
    },
    async createToken(t) {
      tokens.set(t.id, structuredClone(t));
    },
    async findTokenByHash(hash) {
      for (const t of tokens.values()) if (t.tokenHash === hash) return structuredClone(t);
      return null;
    },
    async deleteToken(id, userId) {
      const t = tokens.get(id);
      if (!t || t.userId !== userId) return false;
      tokens.delete(id);
      return true;
    },
    async markEmailVerified(id, at) {
      const u = users.get(id);
      if (u && u.emailVerifiedAt === null) u.emailVerifiedAt = at;
    },
    async changePassword(id, hash) {
      const u = users.get(id);
      if (!u) return 0;
      u.passwordHash = hash;
      return ++u.sessionVersion;
    },
    async createOneTimeToken(t) {
      oneTime.set(t.tokenHash, structuredClone(t));
    },
    async consumeOneTimeToken(hash, purpose) {
      const t = oneTime.get(hash);
      if (!t || t.purpose !== purpose) return null;
      oneTime.delete(hash);
      return t;
    },
    async deleteOneTimeTokens(userId, purpose) {
      for (const [k, t] of oneTime) if (t.userId === userId && t.purpose === purpose) oneTime.delete(k);
    },
    inspect: () => ({ store: "memory" }),
  };
}

// ---------------------------------------------------------------------------------------------

/** Tables for `dbUserStore`. Run with `migrate(db, authMigrations)` or let the store do it. */
export const authMigrations: Migration[] = [
  {
    id: "miu_auth_001_users_tokens",
    sql: `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, roles TEXT NOT NULL DEFAULT '[]', password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER);
CREATE INDEX api_tokens_user ON api_tokens (user_id);`,
  },
  {
    id: "miu_auth_002_verify_reset",
    sql: `ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE auth_one_time_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX auth_one_time_tokens_user ON auth_one_time_tokens (user_id, purpose);`,
  },
];

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  roles: string;
  password_hash: string;
  created_at: number;
  email_verified_at: number | null;
  session_version: number;
}
interface OneTimeRow {
  token_hash: string;
  user_id: string;
  purpose: string;
  created_at: number;
  expires_at: number;
}
interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: number;
  expires_at: number | null;
}

function toUser(r: UserRow | null): StoredUser | null {
  if (!r) return null;
  let roles: string[] = [];
  try {
    const parsed = JSON.parse(r.roles);
    if (Array.isArray(parsed)) roles = parsed.filter((x) => typeof x === "string");
  } catch {}
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    roles,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    emailVerifiedAt: r.email_verified_at ?? null,
    sessionVersion: Number(r.session_version ?? 0),
  };
}

function toOneTime(r: OneTimeRow | null): OneTimeTokenRecord | null {
  if (!r) return null;
  return { tokenHash: r.token_hash, userId: r.user_id, purpose: r.purpose as OneTimeTokenPurpose, createdAt: r.created_at, expiresAt: r.expires_at };
}

function toToken(r: TokenRow | null): ApiTokenRecord | null {
  if (!r) return null;
  return { id: r.id, userId: r.user_id, name: r.name, tokenHash: r.token_hash, createdAt: r.created_at, expiresAt: r.expires_at };
}

export interface DbUserStoreOptions {
  /** Apply `authMigrations` on first use. Default true. Turn off when you run migrations yourself. */
  migrate?: boolean;
}

/** Users and tokens in SQL via @miujs/db (SQLite locally, D1 on Workers). */
export function dbUserStore(database: DatabaseSource, opts: DbUserStoreOptions = {}): UserStore {
  const auto = opts.migrate ?? true;
  const get = async (env: Env) => {
    const d = resolveDatabase(database, env);
    if (auto) await migrateOnce(d, authMigrations);
    return d;
  };
  const USER_COLS = "id, email, name, roles, password_hash, created_at, email_verified_at, session_version";
  const ONE_TIME_COLS = "token_hash, user_id, purpose, created_at, expires_at";
  return {
    kind: "db",
    async findUserByEmail(email, env) {
      const d = await get(env);
      return toUser(await d.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).bind(normalizeEmail(email)).first<UserRow>());
    },
    async findUserById(id, env) {
      const d = await get(env);
      return toUser(await d.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first<UserRow>());
    },
    async createUser(u, env) {
      const d = await get(env);
      const user: StoredUser = {
        id: randomId(16),
        email: normalizeEmail(u.email),
        name: u.name ?? null,
        roles: [...u.roles],
        passwordHash: u.passwordHash,
        createdAt: Date.now(),
        emailVerifiedAt: null,
        sessionVersion: 0,
      };
      const r = await d
        .prepare("INSERT INTO users (id, email, name, roles, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING")
        .bind(user.id, user.email, user.name, JSON.stringify(user.roles), user.passwordHash, user.createdAt)
        .run();
      return r.meta.changes === 1 ? user : null;
    },
    async updatePasswordHash(id, hash, env) {
      const d = await get(env);
      await d.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, id).run();
    },
    async createToken(t, env) {
      const d = await get(env);
      await d
        .prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(t.id, t.userId, t.name, t.tokenHash, t.createdAt, t.expiresAt)
        .run();
    },
    async findTokenByHash(hash, env) {
      const d = await get(env);
      return toToken(await d.prepare("SELECT id, user_id, name, token_hash, created_at, expires_at FROM api_tokens WHERE token_hash = ?").bind(hash).first<TokenRow>());
    },
    async deleteToken(id, userId, env) {
      const d = await get(env);
      const r = await d.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(id, userId).run();
      return r.meta.changes > 0;
    },
    async markEmailVerified(id, at, env) {
      const d = await get(env);
      await d.prepare("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL").bind(at, id).run();
    },
    async changePassword(id, hash, env) {
      const d = await get(env);
      const v = await d.prepare("UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ? RETURNING session_version").bind(hash, id).first<number>("session_version");
      return Number(v ?? 0);
    },
    async createOneTimeToken(t, env) {
      const d = await get(env);
      await d
        .prepare(`INSERT INTO auth_one_time_tokens (${ONE_TIME_COLS}) VALUES (?, ?, ?, ?, ?)`)
        .bind(t.tokenHash, t.userId, t.purpose, t.createdAt, t.expiresAt)
        .run();
    },
    async consumeOneTimeToken(hash, purpose, env) {
      const d = await get(env);
      // One statement: two concurrent consumers cannot both get the row.
      return toOneTime(await d.prepare(`DELETE FROM auth_one_time_tokens WHERE token_hash = ? AND purpose = ? RETURNING ${ONE_TIME_COLS}`).bind(hash, purpose).first<OneTimeRow>());
    },
    async deleteOneTimeTokens(userId, purpose, env) {
      const d = await get(env);
      await d.prepare("DELETE FROM auth_one_time_tokens WHERE user_id = ? AND purpose = ?").bind(userId, purpose).run();
    },
    inspect: () => ({ store: "db", database: describeDatabase(database) }),
    cloudflare: () => {
      const info = describeDatabase(database);
      return typeof info.binding === "string" ? { d1: [info.binding] } : {};
    },
  };
}
