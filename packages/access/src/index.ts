// @miujs/access — roles, permissions, row-level policies and multi-tenancy (orgs, members,
// invitations). Needs a user on ctx (from @miujs/auth): put access() after auth() in plugins.
//
// Tenant isolation pattern: every query on tenant data filters by org_id, taken from
// tenantScope(ctx), never from the request body:
//
//   const orgId = tenantScope(ctx); // throws 400 when no org is active
//   db.prepare("SELECT * FROM contacts WHERE org_id = ? AND id = ?").bind(orgId, id)
//   db.prepare("UPDATE contacts SET name = ? WHERE org_id = ? AND id = ?").bind(name, orgId, id)
//   db.prepare("INSERT INTO contacts (id, org_id, name) VALUES (?, ?, ?)").bind(id, orgId, name)

import { accessPlugin, type AccessOptions } from "./plugin.ts";
import { accessRoutes, type RouteState } from "./routes.ts";

export * from "./permissions.ts";
export * from "./store.ts";
export { accessRoutes, randomToken, sha256Hex } from "./routes.ts";
export { notMember, tenantScope, type AccessOptions, type Mailer, type OrgSource } from "./plugin.ts";

/**
 * Permissions and multi-tenancy:
 *
 * ```ts
 * access({ roles: defineRoles({ owner: ["*"], member: ["contacts:read"] }), database: sqlite("app.db") })
 * ```
 *
 * Built-in routes use the permissions `members:read`, `members:invite` and `members:manage`.
 */
export function access(opts: AccessOptions) {
  const state: RouteState = { dev: true };
  return accessPlugin(opts, opts.routes === false ? [] : accessRoutes(opts, state), state);
}
