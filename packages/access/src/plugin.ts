// The access() plugin: ctx.can / ctx.authorize / ctx.org, with verified org membership.

import { definePlugin, errors, type CloudflareNeeds, type Context, type RouteDef } from "miujs";
import { describeDatabase, resolveDatabase, type Database, type DatabaseSource } from "@miujs/db";
import { evaluate, type OrgInfo, type Permission, type Policy, type Roles } from "./permissions.ts";
import { accessStore, type AccessStore } from "./store.ts";
import { accessManage } from "./manage.ts";

export type OrgSource = "header" | "path" | "session" | ((ctx: Context) => string | null | undefined | Promise<string | null | undefined>);

/** Anything with this shape can send invitation emails (e.g. `@miujs/mail`). */
export interface Mailer {
  send(message: { to: string; subject: string; html: string; text: string }): unknown | Promise<unknown>;
}

export interface AccessOptions {
  roles: Roles;
  policies?: Policy[];
  /** Where orgs and memberships live. Default: `ctx.db` from `@miujs/db`. */
  database?: DatabaseSource;
  /**
   * Your own `AccessStore` (or one per request), instead of the built-in SQL store on `database`.
   * `counts`, `pageOrgs` and `pageMembers` are optional: without them `manage()` omits the views
   * that need them.
   */
  store?: AccessStore | ((ctx: Context) => AccessStore);
  /**
   * Where the active org id comes from. A route with `:orgId` in its path always uses that.
   * Otherwise: `"header"` (default, `x-org-id`), `"session"` (session key `orgId`), `"path"`
   * (only the path), or a function.
   */
  orgFrom?: OrgSource;
  /** The role that creates orgs and cannot be left empty. Default `"owner"`. */
  ownerRole?: string;
  /** Serve the org/member/invite routes. Default true. */
  routes?: boolean;
  /** Prefix for the routes. Default `""` (so `/orgs`, `/invites/:token/accept`). */
  basePath?: string;
  /** Sends invitation emails. Without one, dev responses include the invite URL. */
  mailer?: Mailer;
  /** Default 7. */
  inviteTtlDays?: number;
  /** Let anyone signed in accept an invite, not just the invited email. Default false. */
  allowAnyEmail?: boolean;
  /** Public base URL for invite links. Default: `env.APP_URL`, or the request origin in dev only. */
  appUrl?: string;
  /** Build the link put in invite emails. Default `${appUrl}/invites/${token}`. */
  inviteUrl?: (token: string, ctx: Context) => string;
}

declare module "miujs" {
  interface Context {
    /** True when the signed-in user may do `permission` (and the record passes its policy). */
    can(permission: string, record?: unknown): boolean;
    /** Throws 401 when signed out, 403 `MIU_E_FORBIDDEN` when `can()` is false. */
    authorize(permission: string, record?: unknown): void;
    /** The active organization and your role in it, or null. Membership is verified. */
    readonly org: OrgInfo | null;
  }
}

export const notMember = () =>
  errors.custom({
    code: "MIU_E_ACCESS_NOT_MEMBER",
    status: 403,
    message: "You are not a member of this organization",
    fix: "Use an organization id from GET /orgs, or ask one of its owners to invite you.",
  });

function databaseMissing() {
  return errors.config(
    "MIU_E_ACCESS_DATABASE_MISSING",
    "access() needs a database for organizations",
    "Pass access({ database }) (e.g. sqlite() or d1(\"DB\")), or add db() from @miujs/db before access() in plugins.",
  );
}

/** Finds the database for this request: the option, else `ctx.db`. */
export function databaseFor(opts: AccessOptions, ctx: Context): Database {
  if (opts.database) return resolveDatabase(opts.database, ctx.env);
  const fromCtx = (ctx as { db?: Database }).db;
  if (fromCtx && typeof fromCtx.prepare === "function") return fromCtx;
  throw databaseMissing();
}

export function storeFor(opts: AccessOptions, ctx: Context): AccessStore {
  const s = opts.store;
  if (s) return typeof s === "function" ? s(ctx) : s;
  return accessStore(databaseFor(opts, ctx));
}

async function orgCandidate(ctx: Context, from: OrgSource): Promise<unknown> {
  const fromPath = (ctx.params as Record<string, unknown> | undefined)?.orgId;
  if (fromPath !== undefined) return fromPath;
  if (from === "path") return undefined;
  if (from === "header") return ctx.headers.get("x-org-id") ?? undefined;
  if (from === "session") {
    const s = (ctx as { session?: { get?(k: string): unknown } }).session;
    if (!s || typeof s.get !== "function") {
      throw errors.config("MIU_E_ACCESS_SESSION_MISSING", 'access({ orgFrom: "session" }) needs the session plugin', "Add session() before access() in plugins, or use orgFrom: \"header\".");
    }
    return s.get("orgId");
  }
  return from(ctx);
}

function define(ctx: Context, key: string, value: unknown) {
  Object.defineProperty(ctx, key, { value, writable: false, configurable: true, enumerable: true });
}

/**
 * Permissions and multi-tenancy.
 *
 * ```ts
 * miu({ plugins: [session(), auth(), access({ roles, policies, database: sqlite("app.db") })] })
 * ```
 */
export function accessPlugin(opts: AccessOptions, routes: RouteDef[], state: { dev: boolean } = { dev: true }) {
  const roles = opts.roles;
  const policies = opts.policies ?? [];
  const ownerRole = opts.ownerRole ?? "owner";
  const from = opts.orgFrom ?? "header";
  if (!Object.prototype.hasOwnProperty.call(roles, ownerRole)) {
    throw errors.config("MIU_E_ACCESS_OWNER_ROLE_MISSING", `access() needs a "${ownerRole}" role`, `Add ${ownerRole}: ["*"] to defineRoles(), or set access({ ownerRole }) to an existing role.`);
  }

  return definePlugin({
    name: "access",
    routes,
    setup(app) {
      state.dev = app.dev;
    },
    async onRequest(ctx) {
      let org: OrgInfo | null = null;
      const user = ctx.user;
      const roleNames = () => (org ? [org.role] : (user?.roles ?? []));
      const decide = (permission: Permission, record?: unknown) => evaluate({ roles, policies, user, org, roleNames: roleNames() }, permission, record);
      define(ctx, "can", (permission: Permission, record?: unknown) => decide(permission, record).ok);
      define(ctx, "authorize", (permission: Permission, record?: unknown) => {
        const d = decide(permission, record);
        if (d.ok) return;
        if (d.reason === "unauthenticated") throw errors.unauthorized();
        const names = roleNames();
        const who = `Your role${org ? " in this organization" : ""} (${names.length ? names.join(", ") : "none"})`;
        if (d.reason === "policy") {
          const [resource, action] = permission.split(":");
          throw errors.forbidden(
            `Not allowed to ${permission} this record`,
            `The "${resource}" policy for "${action}" denied access to this record. ${who} has "${permission}", but the record-level rule did not pass.`,
          );
        }
        throw errors.forbidden(`Missing permission "${permission}"`, `${who} does not grant "${permission}". Ask an organization owner for a role that includes it, or add it to the role in defineRoles().`);
      });
      define(ctx, "org", null);
      if (!user || !ctx.route) return;
      const candidate = await orgCandidate(ctx, from);
      if (candidate === undefined || candidate === null || candidate === "") return;
      if (typeof candidate !== "string") throw notMember();
      const membership = await storeFor(opts, ctx).getMembership(candidate, user.id);
      if (!membership) throw notMember();
      org = Object.freeze({ id: candidate, role: membership.role });
      define(ctx, "org", org);
    },
    manage() {
      return accessManage(opts);
    },
    inspect() {
      return {
        roles,
        policies: policies.map((p) => ({ resource: p.resource, actions: Object.keys(p.rules) })),
        orgFrom: typeof from === "function" ? "function" : from,
        ownerRole,
        database: opts.store ? "custom store" : opts.database ? describeDatabase(opts.database) : "ctx.db",
        invites: { mailer: !!opts.mailer, ttlDays: opts.inviteTtlDays ?? 7, allowAnyEmail: !!opts.allowAnyEmail },
      };
    },
    cloudflare(): CloudflareNeeds {
      const d = opts.database ? describeDatabase(opts.database) : null;
      return d && d.adapter === "d1" && typeof d.binding === "string" ? { d1: [d.binding] } : {};
    },
  });
}

/**
 * The active org id, for scoping queries. Throws when no org is active, so a forgotten
 * header can never turn into an unscoped query:
 *
 * ```ts
 * db.prepare("SELECT * FROM contacts WHERE org_id = ?").bind(tenantScope(ctx))
 * ```
 */
export function tenantScope(ctx: Context): string {
  if (typeof (ctx as Partial<Context>).can !== "function") {
    throw errors.config("MIU_E_ACCESS_PLUGIN_MISSING", "tenantScope() needs the access plugin", "Add access({ roles }) to miu({ plugins }) after auth().");
  }
  const org = ctx.org;
  if (!org) {
    throw errors.custom({
      code: "MIU_E_ACCESS_NO_ORG",
      status: 400,
      message: "No organization selected for this request",
      fix: "Send the organization id in the x-org-id header (or call a route with :orgId, or set the session orgId, depending on access({ orgFrom })). List yours with GET /orgs.",
    });
  }
  return org.id;
}
