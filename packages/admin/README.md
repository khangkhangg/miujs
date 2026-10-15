# @miujs/admin

> An admin and CRM backend for MiuJS, plus a System area that manages every plugin of the app.

Define a resource once and `admin()` gives you its table, migrations, REST API, MCP tools, lifecycle events, permissions, audit trail, full-text search and CSV import/export. `@miujs/admin/ui` adds server-rendered admin screens and a visual workflow builder. The **System area** shows every plugin's status, lists, runtime settings and actions, using what each plugin returns from `manage()`.

## Install

```bash
bun add @miujs/admin @miujs/db @miujs/access @miujs/audit miujs
```

## Quick start

```ts
import { miu } from "miujs";
import { db, sqlite } from "@miujs/db";
import { access, defineRoles } from "@miujs/access";
import { audit, dbAuditStore } from "@miujs/audit";
import { admin, field, resource } from "@miujs/admin";
import { adminUI } from "@miujs/admin/ui";

const contacts = resource("contacts", {
  fields: { name: field.text({ required: true, searchable: true }), email: field.email({ unique: true }) },
  tenant: "org",
  search: true,
  permissions: "contacts",
});

const roles = defineRoles({
  owner: ["*"],
  member: ["contacts:*"],
  operator: ["system:*"], // the System area: see "Permissions" below
});

const database = sqlite("app.db");
export default miu({
  plugins: [db({ database }), /* auth() */ access({ roles, database }), audit({ store: dbAuditStore(database) }), admin({ resources: [contacts] }), adminUI({ title: "Acme" })],
  mcp: true,
});
```

## What you get

| Piece | Where |
| --- | --- |
| `resource()` / `field.*` | Fields, validation, relations, views, actions, hooks, tenancy, soft delete |
| `admin({ resources })` | REST routes under `basePath` (default `/api`): list/filter/sort/search/cursor, CRUD, bulk, CSV import/export, actions; `GET /api/_admin/schema` |
| `adminMigrations(resources)` | One migration per resource (`admin_001_<table>`), plus `admin_system_001_settings` |
| `crm()` (`@miujs/admin/crm`) | Ready-made companies, contacts, deals, activities and tasks |
| `adminUI()` (`@miujs/admin/ui`) | Screens under `/admin`: records, kanban, calendar, import, workflows, **System** |
| `app.service("admin").data(scope)` | Server-side CRUD for jobs and scripts |

Every UI read and write is a sub-request to the API, so permissions, tenancy and validation apply whatever the page shows.

## The System area

Each battery (and your own plugins) can describe what an operator may see and do with it through `Plugin.manage()` (the contract is in `miujs`: `ManageSection`). The admin renders any plugin's sections generically:

- **status**: stats (with tones) and tables;
- **lists**: paged with an opaque cursor, optional search and filters, and row actions;
- **settings**: a schema plus `get`/`set`, changeable at runtime without a deploy;
- **actions**: validated input, optional `danger` (confirmation in the UI, `destructiveHint` on MCP).

A built-in **app** section shows uptime, runtime, memory (where measurable), routes (method, path, name, auth, MCP), the MCP tool count, the plugin list (with versions when a plugin has a `version` field) and recent error counts (the 50 most recent error codes, counted by the admin's `onError` hook).

### API

All under `<basePath>/_admin/system` (default `/api/_admin/system`), signed-in users only:

| Route | |
| --- | --- |
| `GET /` | Plugins you may read: name, sections, `inspect` available, Cloudflare needs, what you may change |
| `GET /:plugin` | Sections plus `inspect()` output (secret-looking keys redacted) |
| `GET /:plugin/:section` | Status (or `statusError`), lists, settings schema and actions with `allowed` per action |
| `GET /:plugin/:section/lists/:list?cursor&limit&search&filters` | One page `{ rows, next }`; `limit` defaults to 25 and is capped at 100; `filters` is JSON like `{"state":"failed"}` checked against the list's options |
| `POST /:plugin/:section/actions/:action` | Body is the action's input; returns `{ ok: true, result }` |
| `POST /:plugin/:section/lists/:list/:id/actions/:action` | Same, with `{ id }` merged into the validated input |
| `GET / PUT /:plugin/:section/settings` | Read (secrets shown as `"[REDACTED]"`) or replace the settings; sending `"[REDACTED]"` back keeps a secret unchanged |

Path segments and row ids are URL-encoded (ids such as `chat:42` work). Unknown plugins, sections, lists and actions return 404 with `MIU_E_ADMIN_SYSTEM_*` codes and a fix; invalid input returns 400 `MIU_E_VALIDATION`.

### Permissions

With `@miujs/access`, System permissions are checked against the user's **global** roles (`user.roles`), never an organization role: a tenant owning an org (`"*"` in it) must not control the platform. A System request that carries an active organization (e.g. `x-org-id`) is refused with `MIU_E_ADMIN_SYSTEM_ORG_SCOPED`.

| Permission | Grants |
| --- | --- |
| `system:read` | The overview and read access to every plugin |
| `system.<plugin>:read` | One plugin's sections, lists and settings values |
| `system.<plugin>:<action>` | Running that action (actions named `read` or `settings` use `run.read` / `run.settings`) |
| `system.<plugin>:settings` | Changing that plugin's settings |
| `system:<verb>` | That verb on every plugin |
| `system:*` / `system.<plugin>:*` | Everything / everything on one plugin |

Characters other than letters, digits, `_`, `.` and `-` in a plugin name become `_` in its permission: `leaderboard:wins` → `system.leaderboard_wins:reset`.

Recommended roles:

```ts
defineRoles({
  owner: ["*"],
  operator: ["system:*"],                              // runs everything, changes settings
  observer: ["system:read"],                           // sees everything, changes nothing
  queueOps: ["system.queue:read", "system.queue:retry"], // one plugin, one action
});
```

Without `@miujs/access`, the System area requires a signed-in user whose roles include `admin`. It is never open by default.

### Audit

Every action run and settings change is written through `@miujs/audit` (`ctx.audit`, or the `audit` service): `system.action` rows with `resource: "system.<plugin>"`, `resourceId: "<section>/<action>"` (or `<section>/<list>/<id>/<action>`) and metadata `{ plugin, section, list?, id?, action, danger, input, status: "ok" | "error", error? }` with secret-looking keys in `input` redacted; `system.settings` rows with the field-level diff of before/after (secrets redacted by the audit plugin). Without `@miujs/audit` nothing is logged.

### Runtime settings across instances

A settings change is applied to the plugin on the instance that handled it and saved in the `admin_system_settings` table (`plugin`, `section`, JSON `value`, `updated_at`, `updated_by`; created by `adminMigrations()`, D1 or SQLite). Every instance — each Workers isolate included — re-reads that table on its first request and then at most once per `systemSettingsTtlMs` (default 30 000 ms), and calls `set()` for each value that changed since it last applied it. So a change reaches every instance within the TTL, and a new instance starts with the saved values. A stored value that no longer matches the plugin's schema is skipped (and logged), not applied. If you manage migrations yourself, run `adminMigrations()` before using settings; `adminTables()` also describes the table, so a Drizzle `diffSchema` creates it.

### MCP

With `miu({ mcp: true })`, every System action is an MCP tool named `system_<plugin>_<action>` (row actions take the row `id` as an argument; a clash adds the section: `system_<plugin>_<section>_<action>`). Its input schema is the action's, `danger` sets `destructiveHint`, and a call runs the same route as the API, so permission checks, validation and audit are identical. Three read-only tools (`readOnlyHint`) let agents look around first: `system_overview` (plugins and their sections), `system_status` (`{ plugin, section }`) and `system_list` (`{ plugin, section, list, cursor?, limit?, search?, filters? }`, `filters` as a JSON object string, `limit` capped at 100). They are the API routes themselves, so permissions and redaction match. `admin({ systemMcp: false })` keeps all System tools off MCP.

### UI

`adminUI()` adds a **System** entry under "Operations" in the navigation for users who may read the System area:

- `/admin/system`: one card per plugin with each section's stats;
- `/admin/system/:plugin/:section`: a tab per section with stats, tables, lists (search, filters, paging, row actions), a settings form generated from the schema (booleans as checkboxes, enums as selects, numbers, text, JSON for unions; empty nullable fields send `null`, empty secret fields keep the current value), and action forms. Danger actions ask for confirmation.

Plugin data is escaped everywhere; actions only appear when allowed, and the API checks again.

### Options

| `admin({ ... })` | Default | |
| --- | --- | --- |
| `system` | `true` | Serve the System area |
| `systemMcp` | `true` | Offer actions as MCP tools |
| `systemSettingsTtlMs` | `30000` | How long an instance trusts the settings it read |
| `now` | `Date.now` | Clock for uptime and the settings TTL (tests pass a fake) |

### Writing `manage()` for your own plugin

```ts
import { definePlugin, t } from "miujs";

let paused = false;
export const mailer = () =>
  definePlugin({
    name: "mailer",
    manage: () => [
      {
        id: "outbox",
        title: "Outbox",
        status: () => ({ stats: [{ label: "Paused", value: paused, tone: paused ? "warning" : "good" }] }),
        settings: { schema: t.object({ paused: t.boolean() }), get: () => ({ paused }), set: (v) => void (paused = v.paused) },
        actions: [{ name: "flush", title: "Send now", danger: true, run: () => ({ sent: 0 }) }],
      },
    ],
  });
```
