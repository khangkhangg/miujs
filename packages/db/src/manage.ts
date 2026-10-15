// db().manage(): the database at a glance for operators (@miujs/admin renders it). Read-only
// except for applying the app's own configured migrations. Never runs SQL an operator types.

import type { Context, ManageSection, ManageStat } from "miujs";
import { quoteIdent } from "./introspect.ts";
import type { Database, Migration } from "./index.ts";

/** At most this many tables are counted on the status page. */
export const MAX_COUNTED_TABLES = 50;
/** Row counts stop here (a full count of a big table costs a full scan, billed per row on D1). */
export const ROW_COUNT_CAP = 10_000;

export interface DbManageDeps {
  resolve(env: Context["env"]): Database;
  describe(): Record<string, unknown>;
  migrations: Migration[];
  migrate(database: Database, migrations: Migration[]): Promise<string[]>;
}

async function tableNames(d: Database): Promise<string[]> {
  const { results } = await d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND name NOT LIKE '!_cf!_%' ESCAPE '!' ORDER BY name").all<{ name: string }>();
  return results.map((r) => r.name);
}

async function applied(d: Database, tables: string[]): Promise<Map<string, number>> {
  if (!tables.includes("_miu_migrations")) return new Map();
  const { results } = await d.prepare("SELECT id, applied_at FROM _miu_migrations").all<{ id: string; applied_at: number }>();
  return new Map(results.map((r) => [r.id, Number(r.applied_at)]));
}

export function dbManage(deps: DbManageDeps): ManageSection[] {
  const configured = deps.migrations;
  const configuredIds = new Set(configured.map((m) => m.id));

  const adapter = () => {
    const info = deps.describe();
    return info.adapter === "d1" && typeof info.binding === "string" ? `d1 (binding ${info.binding})` : String(info.adapter ?? "unknown");
  };

  return [
    {
      id: "database",
      title: "Database",
      description: "Tables, row counts and migrations.",
      async status(ctx) {
        const d = deps.resolve(ctx.env);
        const tables = await tableNames(d);
        const done = await applied(d, tables);
        const counted = tables.slice(0, MAX_COUNTED_TABLES);
        const rows = [];
        for (const t of counted) {
          const n = Number((await d.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoteIdent(t)} LIMIT ${ROW_COUNT_CAP + 1})`).first<number>("n")) ?? 0);
          rows.push({ table: t, rows: n > ROW_COUNT_CAP ? `${ROW_COUNT_CAP}+` : n });
        }
        const pending = configured.filter((m) => !done.has(m.id)).length;
        const stats: ManageStat[] = [
          { label: "Adapter", value: adapter() },
          { label: "Tables", value: tables.length, ...(tables.length > MAX_COUNTED_TABLES ? { hint: `Row counts for the first ${MAX_COUNTED_TABLES} only` } : {}) },
          { label: "Applied migrations", value: done.size, hint: "All recorded in _miu_migrations, from every plugin" },
          { label: "Pending migrations", value: pending, hint: "Configured in db({ migrations }) but not yet applied", ...(pending ? { tone: "warning" as const } : {}) },
        ];
        return {
          stats,
          tables: [{ title: "Tables", columns: [{ key: "table", label: "Table", type: "code" }, { key: "rows", label: `Rows (up to ${ROW_COUNT_CAP})`, type: "number" }], rows }],
        };
      },
      lists: [
        {
          name: "migrations",
          title: "Migrations",
          idKey: "id",
          filters: [{ key: "status", label: "Status", options: ["applied", "pending"] }],
          columns: [
            { key: "id", label: "Id", type: "code" },
            { key: "status", label: "Status" },
            { key: "appliedAt", label: "Applied", type: "date" },
            { key: "configured", label: "In db({ migrations })", type: "boolean" },
          ],
          async list(q, ctx) {
            const d = deps.resolve(ctx.env);
            const done = await applied(d, await tableNames(d));
            const ids = [...new Set([...done.keys(), ...configuredIds])].sort();
            const want = q.filters?.status;
            const all = ids
              .filter((id) => q.cursor === undefined || id > q.cursor)
              .map((id) => ({ id, status: done.has(id) ? "applied" : "pending", appliedAt: done.get(id) ?? null, configured: configuredIds.has(id) }))
              .filter((r) => !want || r.status === want);
            const limit = Math.max(1, Math.min(100, Math.floor(q.limit) || 1));
            const rows = all.slice(0, limit);
            return all.length > limit ? { rows, next: rows[rows.length - 1].id } : { rows };
          },
        },
      ],
      actions: configured.length
        ? [
            {
              name: "runMigrations",
              title: "Apply pending migrations",
              description: "Applies the migrations configured in db({ migrations }) that have not run yet, each in its own transaction. Changes the schema.",
              danger: true,
              async run(_input: unknown, ctx: Context) {
                const ran = await deps.migrate(deps.resolve(ctx.env), configured);
                if (!ran.length) return `Nothing to apply: all ${configured.length} migrations are applied`;
                return `Applied ${ran.length} migration${ran.length === 1 ? "" : "s"}: ${ran.join(", ")}`;
              },
            },
          ]
        : [],
    },
  ];
}
