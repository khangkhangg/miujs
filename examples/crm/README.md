# CRM example

A small CRM built from MiuJS batteries, with a browser admin UI and automation workflows you
can build without code.

| Battery | Used for |
| --- | --- |
| `@miujs/db` | SQLite locally (`DB_PATH`), D1 on Cloudflare (binding `DB`) |
| `@miujs/session` + `@miujs/auth` | Email/password sign-in with a session cookie (CSRF-checked) |
| `@miujs/access` | Organizations and roles: `owner`, `admin`, `sales` |
| `@miujs/audit` | Tamper-evident change history, shown on record timelines |
| `@miujs/workflows` | Durable runs for the built-in and UI-built workflows (`dbRunStore`) |
| `@miujs/admin/crm` | Companies, contacts, deals, activities, tasks + REST API, MCP tools, CSV import/export |
| `@miujs/admin/ui` | The admin screens at `/admin` and the workflow builder at `/admin/workflows` |
| `@miujs/web` | `secureHeaders({ csp: true })`: strict CSP with nonces |

## Run

```bash
bun examples/crm/seed.ts                    # creates crm.db with 3 users and sample data
DB_PATH=crm.db bun examples/crm/app.ts      # http://localhost:3000/admin
```

Sign in with any seeded user (password `correct horse battery`, or `SEED_PASSWORD` when you seeded):

| User | Role | Can |
| --- | --- | --- |
| owner@example.com | owner | everything |
| admin@example.com | admin | all CRM data, see members, build and publish workflows |
| sales@example.com | sales | create and update companies, contacts and deals; activities and tasks; view workflows |

Set `SESSION_SECRET` (32+ characters) for anything beyond a demo.

### What to try

- **Deals → Pipeline**: drag a card to another stage, or focus it and press ← / →.
- **Contacts**: filter (field + operator + value), search, sort, select rows for bulk actions, export CSV.
- **Contacts → Import CSV**: upload, map columns, check the dry-run report, then import.
- **A contact**: edit fields, run "Mark lost", see the timeline of activities and changes.
- **Workflows → New workflow**: trigger on `contacts.created`, add a condition
  (`stage is lead`), add the action `crm.create_task`, then *Save and publish*. Create a lead and
  watch the run under *Runs*.

### The API

Every resource is also a REST API and MCP tool. API clients pick the organization with the
`x-org-id` header (`GET /orgs` lists yours); the admin UI keeps it in the session.

```bash
curl -X POST localhost:3000/auth/login -H "content-type: application/json" -H "origin: http://localhost:3000" \
  -d "{\"email\":\"owner@example.com\",\"password\":\"correct horse battery\"}" -c jar
curl localhost:3000/orgs -b jar
curl "localhost:3000/api/deals?view=pipeline" -b jar -H "x-org-id: <org id>"
```

## Test

```bash
bun test examples/crm
```

## Deploy to Cloudflare

```bash
miu deploy cloudflare --entry examples/crm/app.ts --dry-run
```

On Workers the app uses the D1 binding `DB` and a Queue for workflow resumes. The admin's tables (CRM records, System settings) are created by `db({ migrations: kit.migrations })` on the first request of each isolate, because `admin()` itself only auto-migrates in dev. Seed a local
SQLite file and load it with `wrangler d1 execute DB --file=...`, or register users through the
UI. Set `SESSION_SECRET` with `wrangler secret put SESSION_SECRET`.
