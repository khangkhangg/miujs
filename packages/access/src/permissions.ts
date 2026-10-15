// Roles, wildcard permissions and row-level policies. Pure functions, no I/O.

import { errors, type AuthUser } from "miujs";

/** `resource:action`, where either side may be `*`, or `*` alone for everything. */
export type Permission = string;
export type Roles = Readonly<Record<string, readonly Permission[]>>;

/** The active organization for a request: its id and the signed-in user's role in it. */
export interface OrgInfo {
  readonly id: string;
  readonly role: string;
}

export interface PolicyInput<R = any> {
  user: AuthUser;
  record: R;
  org: OrgInfo | null;
  /** Role-permission check for the same user (no policies), e.g. `can("contacts:manage")`. */
  can(permission: Permission): boolean;
}

export type PolicyRule<R = any> = (input: PolicyInput<R>) => boolean;

export interface Policy {
  readonly resource: string;
  readonly rules: Readonly<Record<string, PolicyRule>>;
}

const SEGMENT = /^(\*|[a-z0-9][a-z0-9_.-]*)$/i;

function invalid(permission: string, where: string) {
  return errors.config(
    "MIU_E_ACCESS_PERMISSION_INVALID",
    `Invalid permission ${JSON.stringify(permission)} in ${where}`,
    'Write permissions as "resource:action" (letters, digits, _ . -), with "*" for either side, or "*" alone for everything. Example: "contacts:read", "contacts:*".',
  );
}

export function isValidPermission(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (p === "*") return true;
  const parts = p.split(":");
  return parts.length === 2 && parts.every((s) => SEGMENT.test(s));
}

/**
 * Does `pattern` (from a role) grant `permission` (being asked for)? A `*` in the pattern matches
 * any segment, including a `*` in the request; a concrete segment never matches a requested `*`.
 */
export function matchPermission(pattern: Permission, permission: Permission): boolean {
  if (!pattern || !permission) return false;
  if (pattern === "*") return true;
  const p = pattern.split(":");
  const q = permission.split(":");
  if (p.length !== 2 || q.length !== 2) return false;
  return (p[0] === "*" || p[0] === q[0]) && (p[1] === "*" || p[1] === q[1]);
}

/**
 * Declares roles and their permissions. Validates every permission at startup.
 *
 * ```ts
 * const roles = defineRoles({ owner: ["*"], admin: ["contacts:*"], member: ["contacts:read"] });
 * ```
 */
export function defineRoles<const R extends Record<string, readonly Permission[]>>(roles: R): R {
  for (const [name, perms] of Object.entries(roles)) {
    if (!Array.isArray(perms)) throw invalid(String(perms), `role "${name}"`);
    for (const p of perms) if (!isValidPermission(p)) throw invalid(String(p), `role "${name}"`);
  }
  return Object.freeze({ ...roles }) as R;
}

function permsOf(roles: Roles, role: string): readonly Permission[] {
  return Object.prototype.hasOwnProperty.call(roles, role) ? roles[role] : [];
}

/** Does `role` grant `permission`? Unknown roles grant nothing. */
export function roleAllows(roles: Roles, role: string, permission: Permission): boolean {
  return permsOf(roles, role).some((p) => matchPermission(p, permission));
}

/**
 * May someone holding `holder` hand out `target`? True when every permission of `target` is
 * granted by `holder`, so nobody can invite or promote anyone above themselves.
 */
export function roleCovers(roles: Roles, holder: string, target: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(roles, target)) return false;
  return permsOf(roles, target).every((p) => roleAllows(roles, holder, p));
}

/**
 * Row-level rules for one resource, checked after the role permission passes.
 *
 * ```ts
 * policy("contacts", { update: ({ user, record, can }) => record.ownerId === user.id || can("contacts:manage") })
 * ```
 */
export function policy<R = any>(resource: string, rules: Record<string, PolicyRule<R>>): Policy {
  if (!resource || !SEGMENT.test(resource) || resource === "*") {
    throw errors.config("MIU_E_ACCESS_POLICY_INVALID", `Invalid policy resource ${JSON.stringify(resource)}`, 'Name the resource as in permissions, e.g. policy("contacts", { update: ... }).');
  }
  for (const [action, fn] of Object.entries(rules)) {
    if (typeof fn !== "function" || !SEGMENT.test(action) || action === "*") {
      throw errors.config("MIU_E_ACCESS_POLICY_INVALID", `Policy rule "${resource}:${action}" must be a function`, `Write policy("${resource}", { ${action || "update"}: ({ user, record }) => boolean }).`);
    }
  }
  return Object.freeze({ resource, rules: Object.freeze({ ...rules }) });
}

export interface EvaluateInput {
  roles: Roles;
  policies: readonly Policy[];
  user: AuthUser | undefined;
  org: OrgInfo | null;
  /** The roles that apply: the org role when an org is active, else the user's global roles. */
  roleNames: readonly string[];
}

export type Decision = { ok: true } | { ok: false; reason: "unauthenticated" | "role" | "policy" };

/** The full check behind `ctx.can`: role permission first, then the policy when a record is given. */
export function evaluate(input: EvaluateInput, permission: Permission, record?: unknown): Decision {
  const { roles, policies, user, org, roleNames } = input;
  if (!user) return { ok: false, reason: "unauthenticated" };
  const can = (p: Permission) => roleNames.some((r) => roleAllows(roles, r, p));
  if (!can(permission)) return { ok: false, reason: "role" };
  if (record === undefined) return { ok: true };
  const [resource, action = "*"] = permission.split(":");
  for (const pol of policies) {
    if (resource !== "*" && pol.resource !== resource) continue;
    // A wildcard ("contacts:*", "*") asks for every action, so every rule it covers must pass;
    // skipping them would let `can("contacts:*", record)` bypass row-level rules.
    const actions = action === "*" ? Object.keys(pol.rules) : Object.prototype.hasOwnProperty.call(pol.rules, action) ? [action] : [];
    for (const a of actions) {
      let allowed: unknown = false;
      try {
        allowed = pol.rules[a]({ user, record, org, can });
      } catch {
        allowed = false; // A buggy policy denies rather than grants.
      }
      if (allowed !== true) return { ok: false, reason: "policy" };
    }
  }
  return { ok: true };
}
