// One database for everything: users (auth), orgs and members (access), the audit log, workflow
// runs and the app's own tables. Locally SQLite (in memory unless DB_PATH is set); on Cloudflare
// the D1 binding DB (`miu deploy cloudflare` declares it).

import { processEnv, targetRuntime } from "miujs";
import { d1, sqlite, type DatabaseSource, type Migration } from "@miujs/db";
import { workflowMigrations } from "@miujs/workflows";

export const database: DatabaseSource = targetRuntime() === "workerd" ? d1("DB") : sqlite(processEnv().DB_PATH ?? ":memory:");

/** The app's tables. auth, access and audit create their own tables on first use. */
export const migrations: Migration[] = [
  ...workflowMigrations,
  {
    id: "0001_projects",
    sql: `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_org ON projects(org_id, created_at);`,
  },
];
