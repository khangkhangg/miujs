// access().manage(): roles, orgs and memberships for operators (@miujs/admin renders it, checks
// permissions and audits every change). Invite token hashes are never returned.

import { errors, t, type Context, type ManageSection } from "miujs";
import { matchPermission, type Roles } from "./permissions.ts";
import { storeFor, type AccessOptions } from "./plugin.ts";
import { lastOwner, unknownRole } from "./routes.ts";

const Permission = t.string({ minLength: 1, maxLength: 200, pattern: /^(\*|(\*|[a-z0-9][a-z0-9_.-]*):(\*|[a-z0-9][a-z0-9_.-]*))$/i, description: 'e.g. "contacts:read"' });
const MemberIdInput = { id: t.string({ minLength: 3, maxLength: 1024 }) };

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

export function accessManage(opts: AccessOptions): ManageSection[] {
  const roles = opts.roles;
  const roleNames = Object.keys(roles);
  const ownerRole = opts.ownerRole ?? "owner";
  const store = (ctx: Context) => storeFor(opts, ctx);

  return [
    {
      id: "access",
      title: "Access",
      description: "Roles, organizations and who belongs to them.",
      async status(ctx) {
        const c = await store(ctx).counts();
        return {
          stats: [
            { label: "Roles", value: roleNames.length },
            { label: "Organizations", value: c.orgs },
            { label: "Memberships", value: c.members },
            { label: "Pending invites", value: c.pendingInvites },
            { label: "Policies", value: (opts.policies ?? []).length },
          ],
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
      lists: [
        {
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
            const page = await store(ctx).pageOrgs({ cursor: q.cursor, limit: q.limit, search: q.search?.trim() || undefined });
            const rows = page.orgs.map((o) => ({ id: o.id, name: o.name, createdBy: o.createdBy, createdAt: o.createdAt, members: o.members }));
            return page.next === undefined ? { rows } : { rows, next: page.next };
          },
        },
        {
          name: "members",
          title: "Members",
          idKey: "id",
          searchable: true,
          filters: [
            { key: "role", label: "Role", options: roleNames },
          ],
          columns: [
            { key: "orgName", label: "Organization" },
            { key: "email", label: "Email" },
            { key: "userId", label: "User id", type: "code" },
            { key: "role", label: "Role" },
            { key: "createdAt", label: "Joined", type: "date" },
            { key: "orgId", label: "Organization id", type: "code" },
          ],
          async list(q, ctx) {
            const page = await store(ctx).pageMembers({ cursor: q.cursor, limit: q.limit, search: q.search?.trim() || undefined, role: q.filters?.role || undefined });
            const rows = page.members.map((m) => ({ id: memberId(m.orgId, m.userId), orgId: m.orgId, orgName: m.orgName, userId: m.userId, email: m.email, role: m.role, createdAt: m.createdAt }));
            return page.next === undefined ? { rows } : { rows, next: page.next };
          },
          rowActions: [
            {
              name: "changeRole",
              title: "Change role",
              description: `Gives the member another role in this organization. The last ${ownerRole} cannot be demoted.`,
              danger: true,
              input: t.object({ ...MemberIdInput, role: t.enum(roleNames as [string, ...string[]]) }),
              async run({ id, role }: { id: string; role: string }, ctx: Context) {
                const { orgId, userId } = parseMemberId(id);
                if (!has(roles, role)) throw unknownRole(opts, role);
                const st = store(ctx);
                const cur = await st.getMembership(orgId, userId);
                if (!cur) throw errors.notFound("Member", `${userId} in ${orgId}`);
                if (cur.role === role) return `${userId} is already ${role} in ${orgId}`;
                const r = await st.setRole(orgId, userId, role, ownerRole);
                if (r === "not_found") throw errors.notFound("Member", `${userId} in ${orgId}`);
                if (r === "last_owner") throw lastOwner(ownerRole);
                return `${userId} is now ${role} in ${orgId} (was ${cur.role})`;
              },
            },
            {
              name: "removeMember",
              title: "Remove from organization",
              description: `Removes the member from this organization. The last ${ownerRole} cannot be removed.`,
              danger: true,
              input: t.object(MemberIdInput),
              async run({ id }: { id: string }, ctx: Context) {
                const { orgId, userId } = parseMemberId(id);
                const r = await store(ctx).removeMember(orgId, userId, ownerRole);
                if (r === "not_found") return `${userId} is not a member of ${orgId}`;
                if (r === "last_owner") throw lastOwner(ownerRole);
                return `Removed ${userId} from ${orgId}`;
              },
            },
          ],
        },
      ],
      actions: [
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
      ],
    },
  ];
}
