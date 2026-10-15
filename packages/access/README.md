# @miujs/access

> Roles, wildcard permissions, row-level policies and multi-tenant organizations with members and email invitations for MiuJS.

`access()` adds `ctx.can()`, `ctx.authorize()` and `ctx.org` to every request. You declare roles as lists of `resource:action` permissions, optionally add per-record policies, and the plugin resolves the active organization from a header, path, session or function, verifying that the signed-in user is a member. It also serves routes to create orgs, list and manage members, and invite people by email. Use it after `auth()` from `@miujs/auth` (or any plugin that sets `ctx.user`) when an app has roles or tenants.

## Install

```bash
bun add @miujs/access @miujs/db miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route } from "miujs";
import { sqlite } from "@miujs/db";
import { session } from "@miujs/session";
import { auth } from "@miujs/auth";
import { access, defineRoles, tenantScope } from "@miujs/access";

const database = sqlite("app.db");
const roles = defineRoles({
  owner: ["*"],
  admin: ["contacts:*", "members:*"],
  member: ["contacts:read", "members:read"],
});

const listContacts = route.get("/contacts", {
  auth: "required",
  handler: async (ctx) => {
    ctx.authorize("contacts:read"); // 401 signed out, 403 without the permission
    const orgId = tenantScope(ctx); // 400 when no org is selected
    const { results } = await database.prepare("SELECT id, name FROM contacts WHERE org_id = ?").bind(orgId).all();
    return { contacts: results };
  },
});

export default miu({
  plugins: [session(), auth(), access({ roles, database })],
  routes: [listContacts],
});
```

Clients select the organization with the `x-org-id` header. `GET /orgs` lists the user's orgs.

## Roles and permissions

- A permission is `resource:action`. Either side may be `*`, and `*` alone grants everything. Segments use letters, digits, `_`, `.` and `-`.
- `defineRoles()` validates every permission at startup (`MIU_E_ACCESS_PERMISSION_INVALID`) and freezes the result.
- When an org is active, the user's role in that org applies. Without one, the user's global `ctx.user.roles` apply.
- `ctx.can(permission, record?)` returns a boolean. `ctx.authorize(permission, record?)` throws 401 when signed out and 403 `MIU_E_FORBIDDEN` otherwise, with a `fix` naming the missing permission.
- The built-in routes use `members:read`, `members:invite` and `members:manage`. The `ownerRole` (default `owner`) must exist in `roles`.

The checks are plain functions, so they can be used outside requests:

<!-- test -->
```ts
import { defineRoles, matchPermission, roleAllows, roleCovers } from "@miujs/access";

const roles = defineRoles({ owner: ["*"], admin: ["contacts:*"], member: ["contacts:read"] });

matchPermission("contacts:*", "contacts:update"); // true
roleAllows(roles, "member", "contacts:update"); // false
roleCovers(roles, "admin", "member"); // true: admin holds every permission of member
roleCovers(roles, "member", "admin"); // false
```

`roleCovers` is what stops anyone inviting or promoting someone above their own role (`MIU_E_ACCESS_ROLE_TOO_HIGH`).

## Row-level policies

A policy adds a per-record rule, checked after the role permission passes and only when a record is given. A rule that throws or returns anything other than `true` denies.

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { sqlite } from "@miujs/db";
import { session } from "@miujs/session";
import { auth } from "@miujs/auth";
import { access, defineRoles, policy, tenantScope } from "@miujs/access";

const database = sqlite();
const roles = defineRoles({ owner: ["*"], editor: ["contacts:read", "contacts:update"] });
const policies = [
  policy<{ ownerId: string }>("contacts", {
    update: ({ user, record, can }) => record.ownerId === user.id || can("contacts:manage"),
  }),
];

const updateContact = route.post("/contacts/:id", {
  auth: "required",
  params: t.object({ id: t.string() }),
  handler: async (ctx) => {
    const row = await database
      .prepare("SELECT id, owner_id AS ownerId FROM contacts WHERE id = ? AND org_id = ?")
      .bind(ctx.params.id, tenantScope(ctx))
      .first<{ id: string; ownerId: string }>();
    if (!row) return new Response("Not found", { status: 404 });
    ctx.authorize("contacts:update", row);
    return { updated: row.id };
  },
});

export default miu({ plugins: [session(), auth(), access({ roles, policies, database })], routes: [updateContact] });
```

## Organizations and tenant isolation

`ctx.org` is `{ id, role }` for the active org, or `null`. The org id comes from, in order:

1. a `:orgId` path parameter, when the route has one;
2. otherwise `orgFrom`: `"header"` (default, `x-org-id`), `"session"` (session key `orgId`, needs `session()`), `"path"` (path only), or a function `(ctx) => string | null | undefined`.

Membership is checked on every request; a non-member gets 403 `MIU_E_ACCESS_NOT_MEMBER`. Scope every tenant query with `tenantScope(ctx)`, never an org id from the request body. It throws 400 `MIU_E_ACCESS_NO_ORG` when no org is active, so a forgotten header cannot become an unscoped query.

## Built-in routes

Served unless `routes: false`, under `basePath` (default `""`):

| Route | Permission | What it does |
| --- | --- | --- |
| `POST /orgs` | signed in | `{ name }`. Creates an org; you become its `ownerRole`. |
| `GET /orgs` | signed in | Your orgs, with your role in each. |
| `GET /orgs/:orgId/members` | `members:read` | Members and their roles. |
| `POST /orgs/:orgId/invites` | `members:invite` | `{ email, role }`. Invites by email; replaces any pending invite for that email. |
| `POST /invites/:token/accept` | signed in | Accepts an invitation (as the invited email unless `allowAnyEmail`). |
| `PATCH /orgs/:orgId/members/:userId` | `members:manage` | `{ role }`. Changes a role; the last owner cannot be demoted. |
| `DELETE /orgs/:orgId/members/:userId` | `members:manage` (or yourself) | Removes a member or leaves; the last owner cannot leave. |

Invitations:

- Tokens are 32 random bytes, stored as SHA-256 hashes. They work once and expire after `inviteTtlDays` (7).
- Accepting requires the signed-in user's email to match the invite. If `@miujs/auth` reports `emailVerified: false`, accepting is refused (`MIU_E_ACCESS_EMAIL_UNVERIFIED`).
- Links are built from `inviteUrl`, `appUrl` or `env.APP_URL`. The request origin is only used in dev, because the Host header can be forged.
- Without a `mailer`, dev responses include `inviteUrl`. Outside dev a mailer is required.

`accessStore(database)` gives direct access to orgs, members and invites (e.g. for seeding). Its tables (`access_orgs`, `access_memberships`, `access_invites`) are created on first use from `accessMigrations`.

<!-- test -->
```ts
import { sqlite } from "@miujs/db";
import { accessStore } from "@miujs/access";

const store = accessStore(sqlite());
const org = await store.createOrg({ name: "Acme", ownerId: "alice", ownerEmail: "alice@example.com" });
await store.addMember(org.id, "carol", "member", "carol@example.com");
console.log(await store.getMembership(org.id, "carol")); // { role: "member" }
```

## Options

`access(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `roles` | `Roles` | required | Roles from `defineRoles()`. Must include `ownerRole`. |
| `policies` | `Policy[]` | `[]` | Row-level rules from `policy()`. |
| `database` | `DatabaseSource` | `ctx.db` from `db()` in `@miujs/db` | Where orgs, memberships and invites live. |
| `orgFrom` | `"header" \| "path" \| "session" \| (ctx) => string \| null \| undefined` | `"header"` (`x-org-id`) | Where the active org id comes from when the route has no `:orgId`. |
| `ownerRole` | `string` | `"owner"` | Role that creates orgs and cannot be left empty. |
| `routes` | `boolean` | `true` | Serve the org, member and invite routes. |
| `basePath` | `string` | `""` | Prefix for those routes. |
| `mailer` | `Mailer` | none | `{ send({ to, subject, html, text }) }`, e.g. from `@miujs/mail`. |
| `inviteTtlDays` | `number` | `7` | Invitation lifetime in days. |
| `allowAnyEmail` | `boolean` | `false` | Let anyone signed in accept an invite, not just the invited email. |
| `appUrl` | `string` | `env.APP_URL` (request origin in dev only) | Public base URL for invite links. |
| `inviteUrl` | `(token, ctx) => string` | `${appUrl}/invites/${token}` | Build the invite link yourself. |

## Errors

- [`MIU_E_ACCESS_NOT_MEMBER`](../../docs/errors.md#miu_e_access_not_member): 403, the user is not a member of the requested org.
- [`MIU_E_ACCESS_NO_ORG`](../../docs/errors.md#miu_e_access_no_org): 400, `tenantScope()` called with no active org.
- [`MIU_E_ACCESS_ROLE_UNKNOWN`](../../docs/errors.md#miu_e_access_role_unknown): 400, role not in `defineRoles()`.
- [`MIU_E_ACCESS_ROLE_TOO_HIGH`](../../docs/errors.md#miu_e_access_role_too_high): 403, granting or changing a role above your own.
- [`MIU_E_ACCESS_LAST_OWNER`](../../docs/errors.md#miu_e_access_last_owner): 409, removing or demoting the last owner.
- [`MIU_E_ACCESS_INVITE_INVALID`](../../docs/errors.md#miu_e_access_invite_invalid), [`MIU_E_ACCESS_INVITE_USED`](../../docs/errors.md#miu_e_access_invite_used), [`MIU_E_ACCESS_INVITE_EXPIRED`](../../docs/errors.md#miu_e_access_invite_expired), [`MIU_E_ACCESS_INVITE_EMAIL_MISMATCH`](../../docs/errors.md#miu_e_access_invite_email_mismatch): invitation problems.
- [`MIU_E_ACCESS_ALREADY_MEMBER`](../../docs/errors.md#miu_e_access_already_member): 409, inviting an existing member.
- [`MIU_E_ACCESS_EMAIL_UNVERIFIED`](../../docs/errors.md#miu_e_access_email_unverified): 403, accepting an invite before confirming the email.
- [`MIU_E_ACCESS_PERMISSION_INVALID`](../../docs/errors.md#miu_e_access_permission_invalid) / [`MIU_E_ACCESS_POLICY_INVALID`](../../docs/errors.md#miu_e_access_policy_invalid): bad `defineRoles()` or `policy()` input at startup.
- [`MIU_E_ACCESS_OWNER_ROLE_MISSING`](../../docs/errors.md#miu_e_access_owner_role_missing): `ownerRole` not in `roles`.
- [`MIU_E_ACCESS_DATABASE_MISSING`](../../docs/errors.md#miu_e_access_database_missing): no `database` option and no `ctx.db`.
- [`MIU_E_ACCESS_MAILER_MISSING`](../../docs/errors.md#miu_e_access_mailer_missing) / [`MIU_E_ACCESS_APP_URL_MISSING`](../../docs/errors.md#miu_e_access_app_url_missing): invites outside dev without a mailer or public URL.
- [`MIU_E_ACCESS_PLUGIN_MISSING`](../../docs/errors.md#miu_e_access_plugin_missing) / [`MIU_E_ACCESS_SESSION_MISSING`](../../docs/errors.md#miu_e_access_session_missing): `tenantScope()` without `access()`, or `orgFrom: "session"` without `session()`.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

- Use `access({ roles, database: d1("DB") })` with `d1` from `@miujs/db`. The database is resolved from `env` per request, and `access().cloudflare()` declares `d1: ["DB"]` for `miu deploy cloudflare`.
- Without a `database` option it uses `ctx.db` from `db()`, which declares its own binding.
- `APP_URL` is read from `env` per request for invite links.
- No KV or other bindings are used.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [@miujs/auth](../auth/README.md)
- [@miujs/session](../session/README.md)
- [@miujs/db](../db/README.md)
- [@miujs/audit](../audit/README.md)
