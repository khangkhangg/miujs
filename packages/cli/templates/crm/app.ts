// __APP_NAME__: a minimal CRM. Contacts per organization (@miujs/access), stored with @miujs/db, and
// a follow-up workflow (@miujs/workflows). A starter: the full CRM kit is in progress.
//
//   bun app.ts
//   curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
//        -d '{"email":"ann@example.com","password":"correct horse battery"}' -c jar
//   curl -X POST localhost:3000/orgs -b jar -H 'origin: http://localhost:3000' \
//        -H 'content-type: application/json' -d '{"name":"Acme"}'
//   curl -X POST localhost:3000/contacts -b jar -H 'origin: http://localhost:3000' \
//        -H 'x-org-id: <id from above>' -H 'content-type: application/json' -d '{"name":"Ada"}'

import { miu, processEnv, targetRuntime } from "miujs";
import { access, defineRoles } from "@miujs/access";
import { auth, dbUserStore } from "@miujs/auth";
import { d1, db, sqlite, type DatabaseSource } from "@miujs/db";
import { session } from "@miujs/session";
import { dbRunStore, workflowMigrations, workflows } from "@miujs/workflows";
import * as contacts from "./routes/contacts.ts";
import { allWorkflows } from "./workflows.ts";

// Locally SQLite (in memory unless DB_PATH is set); on Cloudflare the D1 binding DB.
const database: DatabaseSource = targetRuntime() === "workerd" ? d1("DB") : sqlite(processEnv().DB_PATH ?? ":memory:");

const migrations = [
  ...workflowMigrations,
  {
    id: "0001_contacts",
    sql: `CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      stage TEXT NOT NULL DEFAULT 'lead',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contacts_org ON contacts(org_id, created_at);`,
  },
];

export const roles = defineRoles({
  owner: ["*"],
  sales: ["contacts:read", "contacts:write", "members:read"],
  viewer: ["contacts:read"],
});

const app = miu({
  name: "__APP_NAME__",
  routes: [contacts],
  plugins: [
    db({ database, migrations }),
    session(),
    auth({ users: dbUserStore(database) }),
    access({ roles }),
    workflows({ workflows: allWorkflows, store: dbRunStore(database) }),
  ],
  mcp: true,
});

export default app;
