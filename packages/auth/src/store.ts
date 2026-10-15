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
  /** Epoch ms when an operator disabled the account, or null. A disabled user cannot sign in. */
  disabledAt?: number | null;
}

/** A page of users for operators (`auth().manage()`), ordered by email. */
export interface UserListQuery {
  /** The last email of the previous page. */
  cursor?: string;
  limit: number;
  /** Case-insensitive substring of the email. */
  search?: string;
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
  /** Deletes every API token of `userId` (done on password reset). Returns how many. */
  deleteUserTokens?(userId: string, env: Env): Promise<number>;

  // Needed for email verification and password reset/change (built-in stores have them).
  /** Sets `emailVerifiedAt` unless it is already set. */
  markEmailVerified?(id: string, at: number, env: Env): Promise<void>;
  /** Sets the hash and bumps `sessionVersion` in one step. Returns the new version. */
  changePassword?(id: string, passwordHash: string, env: Env): Promise<number>;
  createOneTimeToken?(token: OneTimeTokenRecord, env: Env): Promise<void>;
  /** Atomically deletes and returns the token if it exists with this purpose (expired or not). */
  consumeOneTimeToken?(tokenHash: string, purpose: OneTimeTokenPurpose, env: Env): Promise<OneTimeTokenRecord | null>;
  deleteOneTimeTokens?(userId: string, purpose: OneTimeTokenPurpose, env: Env): Promise<void>;

  // Needed for OAuth sign-in (built-in stores have them).
  findOAuthAccount?(provider: string, subject: string, env: Env): Promise<OAuthAccountRecord | null>;
  /** Returns false when (provider, subject) is already linked. */
  createOAuthAccount?(account: OAuthAccountRecord, env: Env): Promise<boolean>;
  /** The user's linked identities, oldest first. */
  listOAuthAccounts?(userId: string, env: Env): Promise<OAuthAccountRecord[]>;
  /** Unlinks the user's identity at `provider`. Returns false when there was none. */
  deleteOAuthAccount?(userId: string, provider: string, env: Env): Promise<boolean>;

  // Needed for passkeys (built-in stores have them).
  /** Returns false when the credential id is already registered. */
  createPasskey?(passkey: PasskeyRecord, env: Env): Promise<boolean>;
  findPasskeyByCredentialId?(credentialId: string, env: Env): Promise<PasskeyRecord | null>;
  listPasskeys?(userId: string, env: Env): Promise<PasskeyRecord[]>;
  /** Deletes the passkey only if it belongs to `userId`. */
  deletePasskey?(id: string, userId: string, env: Env): Promise<boolean>;
  deleteUserPasskeys?(userId: string, env: Env): Promise<void>;
  /** Sets the counter and last-used time only if the stored counter is still `expected`. */
  updatePasskeyUsage?(id: string, expected: number, signCount: number, at: number, env: Env): Promise<boolean>;
  /** Stores a WebAuthn challenge; also a good moment to drop expired ones. */
  createChallenge?(challenge: ChallengeRecord, env: Env): Promise<void>;
  /** Atomically deletes and returns the challenge if it exists with this purpose (expired or not). */
  consumeChallenge?(challenge: string, purpose: ChallengePurpose, env: Env): Promise<ChallengeRecord | null>;

  // Needed for the operator screens in @miujs/admin (built-in stores have them).
  countUsers?(env: Env): Promise<number>;
  listUsers?(q: UserListQuery, env: Env): Promise<{ users: StoredUser[]; next?: string }>;
  /** Sets or clears `disabledAt`. Returns false when there is no such user. */
  setUserDisabled?(id: string, disabledAt: number | null, env: Env): Promise<boolean>;
  /** Bumps `sessionVersion` (signs out every session). Returns the new version, or null when there is no such user. */
  revokeSessions?(id: string, env: Env): Promise<number | null>;

  inspect?(): Record<string, unknown>;
  cloudflare?(): { d1?: string[] };
}

/** A sign-in identity at an OAuth/OpenID provider, linked to one user. */
export interface OAuthAccountRecord {
  id: string;
  /** Provider id, e.g. `google` or a custom OIDC id. */
  provider: string;
  /** The provider's stable user id (`sub`). */
  subject: string;
  userId: string;
  /** The email the provider reported at link time, for display. */
  email: string | null;
  createdAt: number;
}

/** A WebAuthn credential. */
export interface PasskeyRecord {
  id: string;
  userId: string;
  /** base64url credential id. */
  credentialId: string;
  /** Public key as a JWK (converted from the COSE key at registration). */
  publicKey: JsonWebKey;
  /** COSE algorithm: -7 (ES256) or -257 (RS256). */
  algorithm: number;
  signCount: number;
  transports: string[];
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export type ChallengePurpose = "passkey-register" | "passkey-login";

/** A single-use WebAuthn challenge. */
export interface ChallengeRecord {
  /** base64url challenge (random, so it doubles as the key). */
  challenge: string;
  purpose: ChallengePurpose;
  /** The user registering a passkey; null for sign-in. */
  userId: string | null;
  createdAt: number;
  expiresAt: number;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const MAX_PAGE = 100;
const pageSize = (n: number) => Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(n)) || 1));

// ---------------------------------------------------------------------------------------------

/** In-process users. For dev and tests; data is lost on restart. */
export function memoryUserStore(): UserStore {
  const users = new Map<string, StoredUser>();
  const byEmail = new Map<string, string>();
  const tokens = new Map<string, ApiTokenRecord>();
  /** tokenHash → token id, so bearer-token requests are one lookup, not a scan. */
  const tokenByHash = new Map<string, string>();
  const oneTime = new Map<string, OneTimeTokenRecord>();
  const oauth = new Map<string, OAuthAccountRecord>();
  const passkeys = new Map<string, PasskeyRecord>();
  const challenges = new Map<string, ChallengeRecord>();
  // Expired challenges are swept when the map has doubled since the last sweep (amortized O(1)).
  let challengeSweepAt = 64;
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
      const user: StoredUser = { id: randomId(16), email, name: u.name ?? null, roles: [...u.roles], passwordHash: u.passwordHash, createdAt: Date.now(), emailVerifiedAt: null, sessionVersion: 0, disabledAt: null };
      users.set(user.id, user);
      byEmail.set(email, user.id);
      return structuredClone(user);
    },
    async updatePasswordHash(id, hash) {
      const u = users.get(id);
      if (u) u.passwordHash = hash;
    },
    async createToken(t) {
      const old = tokens.get(t.id);
      if (old) tokenByHash.delete(old.tokenHash);
      tokens.set(t.id, structuredClone(t));
      tokenByHash.set(t.tokenHash, t.id);
    },
    async findTokenByHash(hash) {
      const id = tokenByHash.get(hash);
      return clone(id === undefined ? undefined : tokens.get(id));
    },
    async deleteToken(id, userId) {
      const t = tokens.get(id);
      if (!t || t.userId !== userId) return false;
      tokens.delete(id);
      tokenByHash.delete(t.tokenHash);
      return true;
    },
    async deleteUserTokens(userId) {
      let n = 0;
      for (const [k, t] of tokens) if (t.userId === userId) (tokens.delete(k), tokenByHash.delete(t.tokenHash), n++);
      return n;
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
    async findOAuthAccount(provider, subject) {
      return clone(oauth.get(`${provider}\u0000${subject}`));
    },
    async createOAuthAccount(a) {
      const key = `${a.provider}\u0000${a.subject}`;
      if (oauth.has(key)) return false;
      oauth.set(key, structuredClone(a));
      return true;
    },
    async listOAuthAccounts(userId) {
      return [...oauth.values()].filter((a) => a.userId === userId).sort((x, y) => x.createdAt - y.createdAt).map((a) => structuredClone(a));
    },
    async deleteOAuthAccount(userId, provider) {
      let deleted = false;
      for (const [k, a] of oauth) if (a.userId === userId && a.provider === provider) deleted = oauth.delete(k) || deleted;
      return deleted;
    },
    async createPasskey(p) {
      if (passkeys.has(p.credentialId)) return false;
      passkeys.set(p.credentialId, structuredClone(p));
      return true;
    },
    async findPasskeyByCredentialId(credentialId) {
      return clone(passkeys.get(credentialId));
    },
    async listPasskeys(userId) {
      return [...passkeys.values()].filter((p) => p.userId === userId).map((p) => structuredClone(p));
    },
    async deletePasskey(id, userId) {
      for (const [k, p] of passkeys) {
        if (p.id === id && p.userId === userId) return passkeys.delete(k);
      }
      return false;
    },
    async deleteUserPasskeys(userId) {
      for (const [k, p] of passkeys) if (p.userId === userId) passkeys.delete(k);
    },
    async updatePasskeyUsage(id, expected, signCount, at) {
      for (const p of passkeys.values()) {
        if (p.id !== id) continue;
        if (p.signCount !== expected) return false;
        p.signCount = signCount;
        p.lastUsedAt = at;
        return true;
      }
      return false;
    },
    async createChallenge(c) {
      challenges.set(c.challenge, structuredClone(c));
      if (challenges.size >= challengeSweepAt) {
        const now = Date.now();
        for (const [k, v] of challenges) if (v.expiresAt <= now) challenges.delete(k);
        challengeSweepAt = Math.max(64, challenges.size * 2);
      }
    },
    async consumeChallenge(challenge, purpose) {
      const c = challenges.get(challenge);
      if (!c) return null;
      // Expired ones are as good as swept (the caller rejects them either way).
      if (c.expiresAt <= Date.now()) {
        challenges.delete(challenge);
        return null;
      }
      if (c.purpose !== purpose) return null;
      challenges.delete(challenge);
      return c;
    },
    async countUsers() {
      return users.size;
    },
    async listUsers(q) {
      const limit = pageSize(q.limit);
      const needle = q.search ? q.search.toLowerCase() : "";
      const emails = [...byEmail.keys()].filter((e) => (q.cursor === undefined || e > q.cursor) && (!needle || e.includes(needle))).sort();
      const page = emails.slice(0, limit).map((e) => structuredClone(users.get(byEmail.get(e)!)!));
      return emails.length > limit ? { users: page, next: page[page.length - 1].email } : { users: page };
    },
    async setUserDisabled(id, at) {
      const u = users.get(id);
      if (!u) return false;
      u.disabledAt = at;
      return true;
    },
    async revokeSessions(id) {
      const u = users.get(id);
      return u ? ++u.sessionVersion : null;
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
  {
    id: "miu_auth_003_oauth_passkeys",
    sql: `CREATE TABLE oauth_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT, created_at INTEGER NOT NULL, UNIQUE (provider, subject));
CREATE INDEX oauth_accounts_user ON oauth_accounts (user_id);
CREATE TABLE passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, algorithm INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '[]', name TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE INDEX passkeys_user ON passkeys (user_id);
CREATE TABLE auth_challenges (challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX auth_challenges_expires ON auth_challenges (expires_at);`,
  },
  {
    id: "miu_auth_004_disabled",
    sql: `ALTER TABLE users ADD COLUMN disabled_at INTEGER;`,
  },
];

interface OAuthRow {
  id: string;
  provider: string;
  subject: string;
  user_id: string;
  email: string | null;
  created_at: number;
}
interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  algorithm: number;
  sign_count: number;
  transports: string;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
}
interface ChallengeRow {
  challenge: string;
  purpose: string;
  user_id: string | null;
  created_at: number;
  expires_at: number;
}

function toOAuth(r: OAuthRow | null): OAuthAccountRecord | null {
  if (!r) return null;
  return { id: r.id, provider: r.provider, subject: r.subject, userId: r.user_id, email: r.email, createdAt: r.created_at };
}

function toPasskey(r: PasskeyRow | null): PasskeyRecord | null {
  if (!r) return null;
  let transports: string[] = [];
  try {
    const t = JSON.parse(r.transports);
    if (Array.isArray(t)) transports = t.filter((x) => typeof x === "string");
  } catch {}
  return {
    id: r.id,
    userId: r.user_id,
    credentialId: r.credential_id,
    publicKey: JSON.parse(r.public_key),
    algorithm: Number(r.algorithm),
    signCount: Number(r.sign_count),
    transports,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
  };
}

function toChallenge(r: ChallengeRow | null): ChallengeRecord | null {
  if (!r) return null;
  return { challenge: r.challenge, purpose: r.purpose as ChallengePurpose, userId: r.user_id, createdAt: r.created_at, expiresAt: r.expires_at };
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  roles: string;
  password_hash: string;
  created_at: number;
  email_verified_at: number | null;
  session_version: number;
  disabled_at?: number | null;
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
    disabledAt: r.disabled_at ?? null,
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
  const USER_COLS = "id, email, name, roles, password_hash, created_at, email_verified_at, session_version, disabled_at";
  const ONE_TIME_COLS = "token_hash, user_id, purpose, created_at, expires_at";
  const OAUTH_COLS = "id, provider, subject, user_id, email, created_at";
  const PASSKEY_COLS = "id, user_id, credential_id, public_key, algorithm, sign_count, transports, name, created_at, last_used_at";
  const CHALLENGE_COLS = "challenge, purpose, user_id, created_at, expires_at";
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
        disabledAt: null,
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
    async deleteUserTokens(userId, env) {
      const d = await get(env);
      const r = await d.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(userId).run();
      return r.meta.changes;
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
    async findOAuthAccount(provider, subject, env) {
      const d = await get(env);
      return toOAuth(await d.prepare(`SELECT ${OAUTH_COLS} FROM oauth_accounts WHERE provider = ? AND subject = ?`).bind(provider, subject).first<OAuthRow>());
    },
    async createOAuthAccount(a, env) {
      const d = await get(env);
      const r = await d
        .prepare(`INSERT INTO oauth_accounts (${OAUTH_COLS}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO NOTHING`)
        .bind(a.id, a.provider, a.subject, a.userId, a.email, a.createdAt)
        .run();
      return r.meta.changes === 1;
    },
    async listOAuthAccounts(userId, env) {
      const d = await get(env);
      const { results } = await d.prepare(`SELECT ${OAUTH_COLS} FROM oauth_accounts WHERE user_id = ? ORDER BY created_at`).bind(userId).all<OAuthRow>();
      return results.map((r) => toOAuth(r)!);
    },
    async deleteOAuthAccount(userId, provider, env) {
      const d = await get(env);
      const r = await d.prepare("DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
      return r.meta.changes > 0;
    },
    async createPasskey(p, env) {
      const d = await get(env);
      const r = await d
        .prepare(`INSERT INTO passkeys (${PASSKEY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(credential_id) DO NOTHING`)
        .bind(p.id, p.userId, p.credentialId, JSON.stringify(p.publicKey), p.algorithm, p.signCount, JSON.stringify(p.transports), p.name, p.createdAt, p.lastUsedAt)
        .run();
      return r.meta.changes === 1;
    },
    async findPasskeyByCredentialId(credentialId, env) {
      const d = await get(env);
      return toPasskey(await d.prepare(`SELECT ${PASSKEY_COLS} FROM passkeys WHERE credential_id = ?`).bind(credentialId).first<PasskeyRow>());
    },
    async listPasskeys(userId, env) {
      const d = await get(env);
      const { results } = await d.prepare(`SELECT ${PASSKEY_COLS} FROM passkeys WHERE user_id = ? ORDER BY created_at`).bind(userId).all<PasskeyRow>();
      return results.map((r) => toPasskey(r)!);
    },
    async deletePasskey(id, userId, env) {
      const d = await get(env);
      const r = await d.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(id, userId).run();
      return r.meta.changes > 0;
    },
    async deleteUserPasskeys(userId, env) {
      const d = await get(env);
      await d.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId).run();
    },
    async updatePasskeyUsage(id, expected, signCount, at, env) {
      const d = await get(env);
      const r = await d.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ? AND sign_count = ?").bind(signCount, at, id, expected).run();
      return r.meta.changes === 1;
    },
    async createChallenge(c, env) {
      const d = await get(env);
      await d.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(Date.now()).run();
      await d.prepare(`INSERT INTO auth_challenges (${CHALLENGE_COLS}) VALUES (?, ?, ?, ?, ?)`).bind(c.challenge, c.purpose, c.userId, c.createdAt, c.expiresAt).run();
    },
    async consumeChallenge(challenge, purpose, env) {
      const d = await get(env);
      return toChallenge(await d.prepare(`DELETE FROM auth_challenges WHERE challenge = ? AND purpose = ? RETURNING ${CHALLENGE_COLS}`).bind(challenge, purpose).first<ChallengeRow>());
    },
    async countUsers(env) {
      const d = await get(env);
      return Number((await d.prepare("SELECT COUNT(*) AS n FROM users").first<number>("n")) ?? 0);
    },
    async listUsers(q, env) {
      const d = await get(env);
      const limit = pageSize(q.limit);
      const where: string[] = [];
      const values: unknown[] = [];
      if (q.cursor !== undefined) {
        where.push("email > ?");
        values.push(q.cursor);
      }
      if (q.search) {
        // LIKE wildcards in the search are literal characters.
        where.push("email LIKE ? ESCAPE '!'");
        values.push(`%${q.search.toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`);
      }
      const sql = `SELECT ${USER_COLS} FROM users${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY email LIMIT ?`;
      const { results } = await d.prepare(sql).bind(...values, limit + 1).all<UserRow>();
      const page = results.slice(0, limit).map((r) => toUser(r)!);
      return results.length > limit ? { users: page, next: page[page.length - 1].email } : { users: page };
    },
    async setUserDisabled(id, at, env) {
      const d = await get(env);
      const r = await d.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").bind(at, id).run();
      return r.meta.changes > 0;
    },
    async revokeSessions(id, env) {
      const d = await get(env);
      const v = await d.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ? RETURNING session_version").bind(id).first<number>("session_version");
      return v === null || v === undefined ? null : Number(v);
    },
    inspect: () => ({ store: "db", database: describeDatabase(database) }),
    cloudflare: () => {
      const info = describeDatabase(database);
      return typeof info.binding === "string" ? { d1: [info.binding] } : {};
    },
  };
}
