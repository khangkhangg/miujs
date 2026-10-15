// access().manage(): roles, orgs and memberships for operators (@miujs/admin renders it, checks
// permissions and audits every change). Invite token hashes are never returned.
//
// counts(), pageOrgs() and pageMembers() are optional on an AccessStore: without them the status
// omits the counts (and says why) and the lists they feed are left out. Without a members list,
// changing a role and removing a member are offered as section actions by org and user id.

import { errors, t, type Context, type ManageAction, type ManageList, type ManageSection, type ManageStat } from "miujs";
import { matchPermission, type Roles } from "./permissions.ts";
import { storeFor, type AccessOptions } from "./plugin.ts";
import type { AccessStore } from "./store.ts";
import { lastOwner, unknownRole } from "./routes.ts";

const Permission = t.string({ minLength: 1, maxLength: 200, pattern: /^(\*|(\*|[a-z0-9][a-z0-9_.-]*):(\*|[a-z0-9][a-z0-9_.-]*))$/i, description: 'e.g. "contacts:read"' });
const MemberIdInput = { id: t.string({ minLength: 3, maxLength: 1024 }) };
const MemberInput = { orgId: t.string({ minLength: 1, maxLength: 128 }), userId: t.string({ minLength: 1, maxLength: 200 }) };

/** Row id of a membership: `<orgId>/<userId>`, each URI-encoded. */
const memberId = (orgId: string, userId: string) => `${encodeURIComponent(orgId)}/${encodeURIComponent(userId)}`;

function parseMemberId(id: string): { orgId: string; userId: string } {
  const parts = id.split("/");
  let out: { orgId: string; userId: string } | null = null;
  if (parts.length === 2 && parts[0] && parts[1]) {
    try {
      out = { orgId: decodeURIComponent(parts[0]), userId: decodeURIComponent(parts[1]) };
    } catch {}
  }
  if (!out) throw errors.badRequest(`Not a membership id: ${JSON.stringify(id.slice(0, 80))}`, "Use the id from the members list (<orgId>/<userId>).");
  return out;
}

const has = (roles: Roles, role: string) => Object.prototype.hasOwnProperty.call(roles, role);

/** Store methods only the admin uses; a custom store may leave them out. */
const ADMIN_METHODS = ["counts", "pageOrgs", "pageMembers"] as const;
type AdminMethod = (typeof ADMIN_METHODS)[number];
const missingAdmin = (st: AccessStore): AdminMethod[] => ADMIN_METHODS.filter((m) => typeof st[m] !== "function");
const lacks = (m: AdminMethod) =>
  errors.badRequest(`This access store has no ${m}(), so this list is not available`, `Implement ${m}() on your AccessStore (the built-in accessStore() has it), or drop the custom store option.`);

export function accessManage(opts: AccessOptions): ManageSection[] {
  const roles = opts.roles;
  const roleNames = Object.keys(roles);
  const ownerRole = opts.ownerRole ?? "owner";
  const store = (ctx: Context) => storeFor(opts, ctx);
  // A fixed custom store says now which lists it can fill; a per-request one only per request.
  const fixed = opts.store && typeof opts.store !== "function" ? opts.store : null;
  const offers = (m: AdminMethod) => !fixed || typeof fixed[m] === "function";

  async function changeRole(orgId: string, userId: string, role: string, ctx: Context) {
    if (!has(roles, role)) throw unknownRole(opts, role);
    const st = store(ctx);
    const cur = await st.getMembership(orgId, userId);
    if (!cur) throw errors.notFound("Member", `${userId} in ${orgId}`);
    if (cur.role === role) return `${userId} is already ${role} in ${orgId}`;
    const r = await st.setRole(orgId, userId, role, ownerRole);
    if (r === "not_found") throw errors.notFound("Member", `${userId} in ${orgId}`);
    if (r === "last_owner") throw lastOwner(ownerRole);
    return `${userId} is now ${role} in ${orgId} (was ${cur.role})`;
  }

  async function removeMember(orgId: string, userId: string, ctx: Context) {
    const r = await store(ctx).removeMember(orgId, userId, ownerRole);
    if (r === "not_found") return `${userId} is not a member of ${orgId}`;
    if (r === "last_owner") throw lastOwner(ownerRole);
    return `Removed ${userId} from ${orgId}`;
  }

  const changeRoleText = { title: "Change role", description: `Gives the member another role in this organization. The last ${ownerRole} cannot be demoted.`, danger: true };
  const removeText = { title: "Remove from organization", description: `Removes the member from this organization. The last ${ownerRole} cannot be removed.`, danger: true };
  const roleInput = t.enum(roleNames as [string, ...string[]]);

  const lists: ManageList[] = [];
  if (offers("pageOrgs")) {
    lists.push({
      name: "orgs",
      title: "Organizations",
      idKey: "id",
      searchable: true,
      columns: [
        { key: "name", label: "Name" },
        { key: "members", label: "Members", type: "number" },
        { key: "createdBy", label: "Created by", type: "code" },
        { key: "createdAt", label: "Created", type: "date" },
        { key: "id", label: "Id", type: "code" },
      ],
      async list(q, ctx) {
        const st = store(ctx);
        if (!st.pageOrgs) throw lacks("pageOrgs");
        const page = await st.pageOrgs({ cursor: q.cursor, limit: q.limit, search: q.search?.trim() || undefined });
        const rows = page.orgs.map((o) => ({ id: o.id, name: o.name, createdBy: o.createdBy, createdAt: o.createdAt, members: o.members }));
        return page.next === undefined ? { rows } : { rows, next: page.next };
      },
    });
  }
  const membersList = offers("pageMembers");
  if (membersList) {
    lists.push({
      name: "members",
      title: "Members",
      idKey: "id",
      searchable: true,
      filters: [{ key: "role", label: "Role", options: roleNames }],
      columns: [
        { key: "orgName", label: "Organization" },
        { key: "email", label: "Email" },
        { key: "userId", label: "User id", type: "code" },
        { key: "role", label: "Role" },
        { key: "createdAt", label: "Joined", type: "date" },
        { key: "orgId", label: "Organization id", type: "code" },
      ],
      async list(q, ctx) {
        const st = store(ctx);
        if (!st.pageMembers) throw lacks("pageMembers");
        const page = await st.pageMembers({ cursor: q.cursor, limit: q.limit, search: q.search?.trim() || undefined, role: q.filters?.role || undefined });
        const rows = page.members.map((m) => ({ id: memberId(m.orgId, m.userId), orgId: m.orgId, orgName: m.orgName, userId: m.userId, email: m.email, role: m.role, createdAt: m.createdAt }));
        return page.next === undefined ? { rows } : { rows, next: page.next };
      },
      rowActions: [
        {
          name: "changeRole",
          ...changeRoleText,
          input: t.object({ ...MemberIdInput, role: roleInput }),
          async run({ id, role }: { id: string; role: string }, ctx: Context) {
            const { orgId, userId } = parseMemberId(id);
            return changeRole(orgId, userId, role, ctx);
          },
        },
        {
          name: "removeMember",
          ...removeText,
          input: t.object(MemberIdInput),
          async run({ id }: { id: string }, ctx: Context) {
            const { orgId, userId } = parseMemberId(id);
            return removeMember(orgId, userId, ctx);
          },
        },
      ],
    });
  }

  const actions: ManageAction<any>[] = [
    {
      name: "checkPermission",
      title: "Check a permission",
      description: "Would this user (by their role in an organization) or this role be granted a permission? Record-level policies are not evaluated.",
      input: t.object({
        permission: Permission,
        userId: t.optional(t.string({ minLength: 1, maxLength: 200 })),
        orgId: t.optional(t.string({ minLength: 1, maxLength: 128 })),
        role: t.optional(t.string({ minLength: 1, maxLength: 64 })),
      }),
      async run(input: { permission: string; userId?: string; orgId?: string; role?: string }, ctx: Context) {
        let role = input.role;
        if (input.userId !== undefined && input.orgId !== undefined) {
          const m = await store(ctx).getMembership(input.orgId, input.userId);
          if (!m) return { allowed: false, role: null, grantedBy: [], reason: `${input.userId} is not a member of ${input.orgId}` };
          role = m.role;
        }
        if (role === undefined) throw errors.badRequest("Say whose permission to check", "Pass { userId, orgId } to use their role in that organization, or { role } to check a role directly.");
        if (!has(roles, role)) throw unknownRole(opts, role);
        const grantedBy = roles[role].filter((p) => matchPermission(p, input.permission));
        return { allowed: grantedBy.length > 0, role, grantedBy };
      },
    },
  ];
  // Without a members list there is no row to act on: offer the same changes by org and user id.
  if (!membersList) {
    actions.push(
      {
        name: "changeRole",
        ...changeRoleText,
        input: t.object({ ...MemberInput, role: roleInput }),
        run: (i: { orgId: string; userId: string; role: string }, ctx: Context) => changeRole(i.orgId, i.userId, i.role, ctx),
      },
      {
        name: "removeMember",
        ...removeText,
        input: t.object(MemberInput),
        run: (i: { orgId: string; userId: string }, ctx: Context) => removeMember(i.orgId, i.userId, ctx),
      },
    );
  }

  return [
    {
      id: "access",
      title: "Access",
      description: "Roles, organizations and who belongs to them.",
      async status(ctx) {
        const st = store(ctx);
        const stats: ManageStat[] = [{ label: "Roles", value: roleNames.length }];
        if (st.counts) {
          const c = await st.counts();
          stats.push({ label: "Organizations", value: c.orgs }, { label: "Memberships", value: c.members }, { label: "Pending invites", value: c.pendingInvites });
        }
        const missing = missingAdmin(st);
        if (missing.length) {
          stats.push({
            label: "Store",
            value: "custom",
            hint: `This access store has no ${missing.map((m) => `${m}()`).join(", ")}, so the admin leaves out what they would show. Implement them to see counts and lists.`,
          });
        }
        stats.push({ label: "Policies", value: (opts.policies ?? []).length });
        return {
          stats,
          tables: [
            {
              title: "Roles",
              columns: [
                { key: "role", label: "Role" },
                { key: "permissions", label: "Permissions", type: "number" },
                { key: "grants", label: "Grants", type: "code" },
                { key: "owner", label: "Owner role", type: "boolean" },
              ],
              rows: roleNames.map((r) => ({ role: r, permissions: roles[r].length, grants: roles[r].join(", "), owner: r === ownerRole })),
            },
          ],
        };
      },
      lists,
      actions,
    },
  ];
}
