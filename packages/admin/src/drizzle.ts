// `@miujs/admin/drizzle`: the resources' tables as Drizzle tables, built with @miujs/db's
// `tableFromSchema` (snake_case, references, indexes), for typed queries next to the admin API.
// Needs the optional peer `drizzle-orm`; the admin plugin itself does not.

import { t, type Schema } from "miujs";
import { tableFromSchema } from "@miujs/db/drizzle";
import { adminErrors } from "./errors.ts";
import { sqlType } from "./fields.ts";
import type { FieldMetaBase, Resource } from "./resource.ts";
import { checkResources, orderByDependencies, sortKeys } from "./tables.ts";

function columnSchema(f: FieldMetaBase): Schema<any> {
  let base: Schema<any>;
  if (f.type === "boolean") base = t.boolean();
  else if (f.type === "datetime") base = t.date();
  else if (f.type === "tags" || f.type === "multiSelect") base = t.array(t.string());
  else if (f.type === "json") base = t.any();
  else base = sqlType(f) === "INTEGER" ? t.integer() : sqlType(f) === "REAL" ? t.number() : t.string();
  return f.options.required ? base : t.optional(t.nullable(base));
}

/** The storage shape of a resource as a `t.object` (keys are camelCase; columns snake_case). */
export function storageSchema(r: Resource) {
  const shape: Record<string, Schema<any>> = { id: t.string() };
  if (r.tenant === "org") shape.orgId = t.string();
  for (const f of Object.values(r.fields)) shape[f.name] = columnSchema(f);
  if (r.timestamps) {
    shape.createdAt = t.date();
    shape.updatedAt = t.date();
    shape.createdBy = t.optional(t.nullable(t.string()));
    shape.updatedBy = t.optional(t.nullable(t.string()));
  }
  if (r.softDelete) shape.deletedAt = t.optional(t.nullable(t.date()));
  return t.object(shape);
}

type Built = ReturnType<typeof tableFromSchema<string, Record<string, Schema<any>>, "id">>;

/** Drizzle tables (plus descriptions and SQL) for resources, keyed by resource name. */
export function resourceTables(resources: readonly Resource[]): Record<string, Built> {
  checkResources(resources);
  const out: Record<string, Built> = {};
  for (const r of orderByDependencies(resources)) {
    const scope = r.tenant === "org" ? ["orgId"] : [];
    const references: Record<string, { table: unknown; onDelete?: string }> = {};
    const indexes: { columns: string[]; unique?: boolean; name?: string; where?: string }[] = [];
    if (r.tenant === "org") indexes.push({ columns: r.timestamps ? ["orgId", "createdAt"] : ["orgId"], name: `${r.table}_org_${r.timestamps ? "created_" : ""}idx` });
    for (const f of Object.values(r.fields)) {
      if (f.type === "relation") {
        const target = resources.find((x) => x.name === f.options.target)!;
        const table = target === r ? r.table : out[target.name]?.table;
        if (!table) {
          throw adminErrors.resourceInvalid(
            `resourceTables: ${r.name}.${f.name} and ${target.name} reference each other`,
            "Drizzle tables cannot be built for relation cycles between resources; break the cycle or use adminMigrations() only.",
          );
        }
        references[f.name] = { table, ...(f.options.onDelete ? { onDelete: f.options.onDelete } : {}) };
      }
      if (f.options.unique) indexes.push({ columns: [...scope, f.name], unique: true, name: `${r.table}_${f.column}_unique`, ...(r.softDelete ? { where: '"deleted_at" IS NULL' } : {}) });
      else if (f.type === "relation") indexes.push({ columns: [f.name], name: `${r.table}_${f.column}_idx` });
      else if (f.options.index) indexes.push({ columns: [...scope, f.name], name: `${r.table}_${f.column}_idx` });
    }
    for (const k of sortKeys(r)) indexes.push({ columns: [...scope, k, "id"], name: `${r.table}_${r.fields[k].column}_sort_idx` });
    out[r.name] = tableFromSchema(r.table, storageSchema(r), { casing: "snake_case", references: references as never, indexes: indexes as never }) as unknown as Built;
  }
  return out;
}
