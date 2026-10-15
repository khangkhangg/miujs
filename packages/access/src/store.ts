// Orgs, memberships and invitations in SQL (D1 or bun:sqlite through @miujs/db).

import { migrateOnce, type Database, type Migration } from "@miujs/db";

export const accessMigrations: Migration[] = [
  {
    id: "access_001_orgs",
    sql: `
      CREATE TABLE IF NOT EXISTS access_orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_memberships (
        org_id TEXT NOT NULL REFERENCES access_orgs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        email TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS access_memberships_user ON access_memberships (user_id);
      CREATE TABLE IF NOT EXISTS access_invites (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES access_orgs(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        invited_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER,
        accepted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS access_invites_org ON access_invites (org_id, email);
    `,
  },
];

export interface Org {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
}

export interface Member {
  userId: string;
  email: string | null;
  role: string;
  createdAt: number;
}

export interface Invite {
  id: string;
  orgId: string;
  email: string;
  role: string;
  tokenHash: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  acceptedBy: string | null;
}

/** Outcome of a membership change guarded by the last-owner rule. */
export type MemberChange = "ok" | "not_found" | "last_owner";

/** Longest org id we will look up; anything longer is treated as "not a member". */
export const MAX_ORG_ID = 128;

export interface AccessStore {
  readonly database: Database;
  /** Applies `accessMigrations` once. Other methods call it for you. */
  ready(): Promise<void>;
  createOrg(input: { name: string; ownerId: string; ownerEmail?: string | null; ownerRole?: string; id?: string }): Promise<Org>;
  getOrg(id: string): Promise<Org | null>;
  getMembership(orgId: string, userId: string): Promise<{ role: string } | null>;
  listOrgs(userId: string): Promise<(Org & { role: string })[]>;
  listMembers(orgId: string): Promise<Member[]>;
  /** Adds a member, or does nothing if they already belong. Returns true when added. */
  addMember(orgId: string, userId: string, role: string, email?: string | null): Promise<boolean>;
  /** Changes a role. Refuses to demote the last `ownerRole` (default "owner"). Atomic. */
  setRole(orgId: string, userId: string, role: string, ownerRole?: string): Promise<MemberChange>;
  /** Removes a member. Refuses to remove the last `ownerRole` (default "owner"). Atomic. */
  removeMember(orgId: string, userId: string, ownerRole?: string): Promise<MemberChange>;
  createInvite(invite: Invite): Promise<void>;
  findInviteByHash(tokenHash: string): Promise<Invite | null>;
  /** Marks an invite used. Returns false if it was already used or has expired (single use, atomic). */
  consumeInvite(id: string, userId: string, now: number): Promise<boolean>;
  /** Removes unused invites for an email in an org (a new invite replaces older ones). */
  revokePendingInvites(orgId: string, email: string): Promise<number>;

  // For operators (access().manage()).
  /** Counts for a status page: orgs, memberships and unexpired unused invites. */
  counts(now?: number): Promise<{ orgs: number; members: number; pendingInvites: number }>;
  /** Orgs by id, with member counts. `search` is a case-insensitive substring of the name. */
  pageOrgs(q: { cursor?: string; limit: number; search?: string }): Promise<{ orgs: (Org & { members: number })[]; next?: string }>;
  /** Memberships across orgs, by (org id, user id). `search` matches email or user id (substring), or an exact org id. */
  pageMembers(q: { cursor?: string; limit: number; search?: string; role?: string; orgId?: string }): Promise<{ members: (Member & { orgId: string; orgName: string })[]; next?: string }>;
}

const MAX_PAGE = 100;
const pageSize = (n: number) => Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(n)) || 1));
/** `%needle%` for LIKE … ESCAPE '!', with the needle's own wildcards made literal. */
const likeContains = (s: string) => `%${s.replace(/[!%_]/g, (c) => `!${c}`)}%`;

const stores = new WeakMap<Database, AccessStore>();

const orgRow = (r: any): Org => ({ id: r.id, name: r.name, createdBy: r.created_by, createdAt: r.created_at });
const inviteRow = (r: any): Invite => ({
  id: r.id,
  orgId: r.org_id,
  email: r.email,
  role: r.role,
  tokenHash: r.token_hash,
  invitedBy: r.invited_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  acceptedAt: r.accepted_at ?? null,
  acceptedBy: r.accepted_by ?? null,
});

/** Orgs, memberships and invites on a D1-compatible database. One instance per database. */
export function accessStore(database: Database): AccessStore {
  const cached = stores.get(database);
  if (cached) return cached;
  const ready = async () => void (await migrateOnce(database, accessMigrations));
  const q = (sql: string, ...values: unknown[]) => database.prepare(sql).bind(...values);

  const store: AccessStore = {
    database,
    ready,
    async createOrg({ name, ownerId, ownerEmail = null, ownerRole = "owner", id = crypto.randomUUID() }) {
      await ready();
      const now = Date.now();
      await database.batch([
        q("INSERT INTO access_orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)", id, name, ownerId, now),
        q("INSERT INTO access_memberships (org_id, user_id, role, email, created_at) VALUES (?, ?, ?, ?, ?)", id, ownerId, ownerRole, ownerEmail?.toLowerCase() ?? null, now),
      ]);
      return { id, name, createdBy: ownerId, createdAt: now };
    },
    async getOrg(id) {
      await ready();
      const r = await q("SELECT * FROM access_orgs WHERE id = ?", id).first();
      return r ? orgRow(r) : null;
    },
    async getMembership(orgId, userId) {
      if (typeof orgId !== "string" || typeof userId !== "string" || !orgId || orgId.length > MAX_ORG_ID) return null;
      await ready();
      const role = await q("SELECT role FROM access_memberships WHERE org_id = ? AND user_id = ?", orgId, userId).first<string>("role");
      return typeof role === "string" ? { role } : null;
    },
    async listOrgs(userId) {
      await ready();
      const { results } = await q(
        "SELECT o.*, m.role AS role FROM access_memberships m JOIN access_orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.created_at, o.id",
        userId,
      ).all<any>();
      return results.map((r) => ({ ...orgRow(r), role: r.role }));
    },
    async listMembers(orgId) {
      await ready();
      const { results } = await q("SELECT user_id, email, role, created_at FROM access_memberships WHERE org_id = ? ORDER BY created_at, user_id", orgId).all<any>();
      return results.map((r) => ({ userId: r.user_id, email: r.email ?? null, role: r.role, createdAt: r.created_at }));
    },
    async addMember(orgId, userId, role, email = null) {
      await ready();
      const r = await q(
        "INSERT INTO access_memberships (org_id, user_id, role, email, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO NOTHING",
        orgId,
        userId,
        role,
        email?.toLowerCase() ?? null,
        Date.now(),
      ).run();
      return r.meta.changes === 1;
    },
    async setRole(orgId, userId, role, ownerRole = "owner") {
      await ready();
      // One statement, so two owners demoting each other at once cannot both succeed.
      const r = await q(
        `UPDATE access_memberships SET role = ?3 WHERE org_id = ?1 AND user_id = ?2
           AND (role <> ?4 OR ?3 = ?4 OR (SELECT COUNT(*) FROM access_memberships WHERE org_id = ?1 AND role = ?4) > 1)`,
        orgId,
        userId,
        role,
        ownerRole,
      ).run();
      if (r.meta.changes === 1) return "ok";
      return (await store.getMembership(orgId, userId)) ? "last_owner" : "not_found";
    },
    async removeMember(orgId, userId, ownerRole = "owner") {
      await ready();
      const r = await q(
        `DELETE FROM access_memberships WHERE org_id = ?1 AND user_id = ?2
           AND (role <> ?3 OR (SELECT COUNT(*) FROM access_memberships WHERE org_id = ?1 AND role = ?3) > 1)`,
        orgId,
        userId,
        ownerRole,
      ).run();
      if (r.meta.changes === 1) return "ok";
      return (await store.getMembership(orgId, userId)) ? "last_owner" : "not_found";
    },
    async createInvite(i) {
      await ready();
      await q(
        "INSERT INTO access_invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at, accepted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
        i.id,
        i.orgId,
        i.email,
        i.role,
        i.tokenHash,
        i.invitedBy,
        i.createdAt,
        i.expiresAt,
      ).run();
    },
    async findInviteByHash(tokenHash) {
      await ready();
      const r = await q("SELECT * FROM access_invites WHERE token_hash = ?", tokenHash).first();
      return r ? inviteRow(r) : null;
    },
    async consumeInvite(id, userId, now) {
      await ready();
      const r = await q("UPDATE access_invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND expires_at > ?", now, userId, id, now).run();
      return r.meta.changes === 1;
    },
    async revokePendingInvites(orgId, email) {
      await ready();
      const r = await q("DELETE FROM access_invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL", orgId, email).run();
      return r.meta.changes;
    },
    async counts(now = Date.now()) {
      await ready();
      const r = await q(
        `SELECT (SELECT COUNT(*) FROM access_orgs) AS orgs, (SELECT COUNT(*) FROM access_memberships) AS members,
                (SELECT COUNT(*) FROM access_invites WHERE accepted_at IS NULL AND expires_at > ?) AS pending`,
        now,
      ).first<{ orgs: number; members: number; pending: number }>();
      return { orgs: Number(r?.orgs ?? 0), members: Number(r?.members ?? 0), pendingInvites: Number(r?.pending ?? 0) };
    },
    async pageOrgs({ cursor, limit, search }) {
      await ready();
      const n = pageSize(limit);
      const where: string[] = [];
      const values: unknown[] = [];
      if (cursor !== undefined) (where.push("o.id > ?"), values.push(cursor));
      if (search) (where.push("o.name LIKE ? ESCAPE '!'"), values.push(likeContains(search)));
      const { results } = await q(
        `SELECT o.*, (SELECT COUNT(*) FROM access_memberships m WHERE m.org_id = o.id) AS members FROM access_orgs o
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.id LIMIT ?`,
        ...values,
        n + 1,
      ).all<any>();
      const orgs = results.slice(0, n).map((r) => ({ ...orgRow(r), members: Number(r.members) }));
      return results.length > n ? { orgs, next: orgs[orgs.length - 1].id } : { orgs };
    },
    async pageMembers({ cursor, limit, search, role, orgId }) {
      await ready();
      const n = pageSize(limit);
      const where: string[] = [];
      const values: unknown[] = [];
      if (cursor !== undefined) {
        let after: unknown;
        try {
          after = JSON.parse(cursor);
        } catch {}
        if (Array.isArray(after) && after.length === 2 && after.every((x) => typeof x === "string")) {
          where.push("(m.org_id > ? OR (m.org_id = ? AND m.user_id > ?))");
          values.push(after[0], after[0], after[1]);
        }
      }
      if (search) {
        where.push("(m.email LIKE ? ESCAPE '!' OR m.user_id LIKE ? ESCAPE '!' OR m.org_id = ?)");
        values.push(likeContains(search.toLowerCase()), likeContains(search), search);
      }
      if (role) (where.push("m.role = ?"), values.push(role));
      if (orgId) (where.push("m.org_id = ?"), values.push(orgId));
      const { results } = await q(
        `SELECT m.org_id, m.user_id, m.email, m.role, m.created_at, o.name AS org_name FROM access_memberships m JOIN access_orgs o ON o.id = m.org_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.org_id, m.user_id LIMIT ?`,
        ...values,
        n + 1,
      ).all<any>();
      const members = results.slice(0, n).map((r) => ({ orgId: r.org_id, orgName: r.org_name, userId: r.user_id, email: r.email ?? null, role: r.role, createdAt: r.created_at }));
      const last = members[members.length - 1];
      return results.length > n ? { members, next: JSON.stringify([last.orgId, last.userId]) } : { members };
    },
  };
  stores.set(database, store);
  return store;
}
