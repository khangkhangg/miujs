// A small CRM: companies, contacts, deals, activities and tasks with an admin UI, roles,
// an audit trail and automation workflows you can build in the browser.
//
// Locally it uses SQLite (DB_PATH, default in memory); on Cloudflare Workers the same code uses
// D1 (binding DB) and Queues for workflows.
//
//   bun examples/crm/seed.ts          # creates crm.db with users and sample data
//   DB_PATH=crm.db bun examples/crm/app.ts
//   open http://localhost:3000/admin   (owner@example.com / correct horse battery)

import { miu, processEnv, targetRuntime, type Context } from "miujs";
import { access, defineRoles } from "@miujs/access";
import { crm } from "@miujs/admin/crm";
import { adminUI } from "@miujs/admin/ui";
import { audit, dbAuditStore } from "@miujs/audit";
import { auth, dbUserStore } from "@miujs/auth";
import { d1, db, sqlite, type Database, type DatabaseSource } from "@miujs/db";
import { session } from "@miujs/session";
import { secureHeaders } from "@miujs/web";
import { dbRunStore, workflows } from "@miujs/workflows";

const CRM = ["companies", "contacts", "deals", "activities", "tasks"];

/**
 * Organization roles: owner (everything), admin (all CRM data, members and workflows), sales
 * (day-to-day selling). operator is a global role (user.roles, not an org role) for the admin's
 * System area, where every installed package can be inspected and operated.
 */
export const roles = defineRoles({
  owner: ["*"],
  operator: ["system:*"],
  admin: [...CRM.map((r) => `${r}:*`), "members:read", "members:invite", "workflows:*"],
  sales: [
    "companies:read",
    "companies:create",
    "companies:update",
    "contacts:read",
    "contacts:create",
    "contacts:update",
    "contacts:export",
    "deals:read",
    "deals:create",
    "deals:update",
    "activities:*",
    "tasks:*",
    "workflows:read",
  ],
});

export interface CreateAppOptions {
  /** Signs session cookies. Default: $SESSION_SECRET (random in dev). */
  sessionSecret?: string;
  /** Lower PBKDF2 iterations only in tests. */
  passwordIterations?: number;
  dev?: boolean;
  /** SQLite file for local runs. Default: $DB_PATH, else in memory. */
  dbPath?: string;
}

/**
 * The active organization: the x-org-id header (API clients), else the one picked in the admin
 * UI's switcher (stored in the session). @miujs/access verifies membership either way.
 */
function orgFrom(ctx: Context): string | undefined {
  const header = ctx.headers.get("x-org-id");
  if (header) return header;
  const fromSession = (ctx as { session?: { get(k: string): unknown } }).session?.get("orgId");
  return typeof fromSession === "string" ? fromSession : undefined;
}

export function createApp(opts: CreateAppOptions = {}) {
  const local: Database | null = targetRuntime() === "workerd" ? null : sqlite(opts.dbPath ?? processEnv().DB_PATH ?? ":memory:");
  const source: DatabaseSource = local ?? d1("DB");

  const kit = crm({ database: source });
  const flows = workflows({ workflows: kit.workflows, store: dbRunStore(source) });

  const app = miu({
    name: "crm",
    version: "0.1.0",
    dev: opts.dev,
    mcp: { instructions: "A CRM. Call admin_schema first to learn the resources, fields and filters; send x-org-id for the organization." },
    plugins: [
      secureHeaders({ csp: true }),
      // admin() only auto-migrates in dev; db() applies migrations everywhere (on Workers: D1, on
      // the first request of each isolate), so the CRM and System-settings tables exist in production.
      db({ database: source, migrations: kit.migrations }),
      session({ secret: opts.sessionSecret }),
      auth({ users: dbUserStore(source), password: opts.passwordIterations ? { algorithm: "pbkdf2", iterations: opts.passwordIterations } : undefined }),
      access({ roles, database: source, orgFrom }),
      audit({ store: dbAuditStore(source) }),
      flows,
      kit,
      adminUI({ title: "Acme CRM", brand: { accent: "#0f6e5d" } }),
    ],
  });

  return { app, database: local, kit, workflows: flows };
}

export default createApp().app;
