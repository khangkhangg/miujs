// Generated REST routes (and so MCP tools) for each resource.

import { errors, route, t, validate, type Context, type RouteDef, type Schema } from "miujs";
import { tenantScope } from "@miujs/access";
import { adminErrors } from "./errors.ts";
import { operatorsFor, valueSchema } from "./fields.ts";
import { adminSchema, type AdminSchema } from "./meta.ts";
import { mergeFilters, queryFilter } from "./query.ts";
import { Repo, type Runtime, type Scope } from "./repo.ts";
import { createSchema, FILTER_OPS, sortableKeys, updateSchema, type AdminRecord, type Filter, type Resource } from "./resource.ts";
import { exportColumns, exportHeader, exportLine, runImport } from "./transfer.ts";

export interface RouteEnv {
  basePath: string;
  resources: readonly Resource[];
  byName: Map<string, Resource>;
  runtime(ctx: Context): Promise<Runtime>;
  importMaxRows: number;
  exportPageSize: number;
}

type Can = (permission: string, record?: unknown) => boolean;

function canOf(ctx: Context): Can | null {
  const c = (ctx as { can?: unknown }).can;
  return typeof c === "function" ? (c as Can).bind(ctx) : null;
}

function authorizeOf(ctx: Context): ((p: string, rec?: unknown) => void) | null {
  const a = (ctx as { authorize?: unknown }).authorize;
  return typeof a === "function" ? (a as (p: string, rec?: unknown) => void).bind(ctx) : null;
}

export function scopeFor(r: Resource, ctx: Context): Scope {
  const org = (ctx as { org?: { id?: unknown } | null }).org;
  const orgId = r.tenant === "org" ? tenantScope(ctx) : org && typeof org.id === "string" ? org.id : null;
  const authorize = authorizeOf(ctx);
  return { orgId, userId: ctx.user?.id ?? null, ctx, env: ctx.env, authorize: authorize ? (p, rec) => authorize(p, rec) : undefined };
}

function recordSchema(r: Resource): Schema<any> {
  const shape: Record<string, Schema<any>> = { id: t.string() };
  for (const f of Object.values(r.fields)) {
    const base = f.type === "datetime" ? t.string({ format: "date-time" }) : valueSchema(f);
    shape[f.name] = t.optional(t.nullable(base));
  }
  if (r.timestamps) {
    shape.createdAt = t.optional(t.nullable(t.string({ format: "date-time" })));
    shape.updatedAt = t.optional(t.nullable(t.string({ format: "date-time" })));
    shape.createdBy = t.optional(t.nullable(t.string()));
    shape.updatedBy = t.optional(t.nullable(t.string()));
  }
  shape._included = t.optional(t.record(t.unknown(), { description: "Related records requested with include" }));
  return t.object(shape);
}

/** A short, agent-oriented description of a resource's fields and filters. */
export function describeFields(r: Resource): string {
  const lines = Object.values(r.fields).map((f) => {
    const bits: string[] = [f.type];
    if (f.options.choices) bits.push(`one of ${f.options.choices.map((c) => c.value).join("|")}`);
    if (f.type === "relation") bits.push(`id of a ${f.options.target} record`);
    if (f.type === "money") bits.push(`integer minor units of ${f.options.currency}`);
    if (f.options.required) bits.push("required");
    if (f.options.unique) bits.push("unique");
    if (f.options.readOnly) bits.push("read-only");
    return `- ${f.name} (${bits.join(", ")}); filters: ${operatorsFor(f).join(", ")}`;
  });
  return lines.join("\n");
}

function listDescription(r: Resource): string {
  const views = Object.keys(r.views);
  const relations = Object.values(r.fields).filter((f) => f.type === "relation").map((f) => f.name);
  return [
    `Returns { items, nextCursor }. Pass nextCursor back as cursor for the next page (limit 1-200, default 50).`,
    `Filter with \`filter\`, a JSON object {"field": {"op": value}} (or {"field": value} for eq); ops: ${FILTER_OPS.join(", ")}. Dates accept "today", "today+7d", "now". Simple equality also works as a query key, e.g. ${Object.keys(r.fields)[0] ?? "id"}=value.`,
    `Sort with \`sort\`: one of ${sortableKeys(r).join(", ")}; prefix - for descending. Default ${r.defaultSort}.`,
    `\`q\`: full-text search. \`fields\`: comma-separated fields to return.${views.length ? ` \`view\`: a saved view (${views.join(", ")}).` : ""}${relations.length ? ` \`include\`: ${relations.join(", ")} to embed related records under _included.` : ""}`,
    `Fields:\n${describeFields(r)}`,
  ].join("\n");
}

function parseList(raw: string | undefined, what: string): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function pick(rec: AdminRecord, fields: string[] | undefined): AdminRecord {
  if (!fields) return rec;
  const out: Record<string, unknown> = { id: rec.id };
  for (const f of fields) if (f in rec) out[f] = (rec as Record<string, unknown>)[f];
  if ("_included" in rec) out._included = (rec as Record<string, unknown>)._included;
  return out as AdminRecord;
}

function checkFields(r: Resource, fields: string[] | undefined): void {
  if (!fields) return;
  const allowed = ["id", ...Object.keys(r.fields), ...(r.timestamps ? ["createdAt", "updatedAt", "createdBy", "updatedBy"] : [])];
  const bad = fields.filter((f) => !allowed.includes(f));
  if (bad.length) throw adminErrors.fieldsInvalid(bad, allowed);
}

function checkInclude(r: Resource, env: RouteEnv, ctx: Context, include: string[] | undefined): string[] {
  if (!include) return [];
  const relations = Object.values(r.fields).filter((f) => f.type === "relation").map((f) => f.name);
  const bad = include.filter((n) => !relations.includes(n));
  if (bad.length) throw adminErrors.includeInvalid(bad, relations);
  const authorize = authorizeOf(ctx);
  for (const n of include) {
    const target = env.byName.get(r.fields[n].options.target!)!;
    if (target.permissions && authorize) authorize(target.permissions.read);
  }
  return [...new Set(include)];
}

interface ListQuery {
  filter?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
  q?: string;
  fields?: string;
  view?: string;
  include?: string;
}

function resolveList(r: Resource, ctx: Context, q: ListQuery) {
  const view = q.view !== undefined && Object.prototype.hasOwnProperty.call(r.views, q.view) ? r.views[q.view] : undefined;
  if (q.view !== undefined && !view) throw adminErrors.viewUnknown(r.name, q.view, Object.keys(r.views));
  let json: Filter | undefined;
  if (q.filter !== undefined && q.filter.trim() !== "") {
    try {
      json = JSON.parse(q.filter);
    } catch {
      throw adminErrors.filterInvalid("filter is not valid JSON");
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw adminErrors.filterInvalid("filter must be a JSON object");
  }
  const filter = mergeFilters(view?.filter, json, queryFilter(r, q as Record<string, unknown>));
  const fields = parseList(q.fields, "fields") ?? view?.fields;
  checkFields(r, fields);
  return { filter, sort: q.sort ?? view?.sort, fields, q: q.q };
}

/** The row-level read check for embedded relations (`include`): a hidden record becomes null. */
function includeCheck(ctx: Context): ((target: Resource, rec: AdminRecord) => boolean) | undefined {
  const can = canOf(ctx);
  return can ? (target, rec) => !target.permissions || can(target.permissions.read, rec) : undefined;
}

/** Drops records a row-level policy hides from this user. */
function visible(r: Resource, ctx: Context, items: AdminRecord[]): AdminRecord[] {
  const can = canOf(ctx);
  if (!can || !r.permissions) return items;
  const perm = r.permissions.read;
  return items.filter((rec) => can(perm, rec));
}

export function resourceRoutes(r: Resource, env: RouteEnv): RouteDef[] {
  const base = `${env.basePath}/${r.name}`;
  const perm = r.permissions;
  const tags = ["admin", r.name];
  const mcp = r.mcp;
  const record = recordSchema(r);
  const fieldQuery: Record<string, Schema<any>> = {};
  for (const f of Object.values(r.fields)) {
    if (operatorsFor(f).includes("eq")) fieldQuery[f.name] = t.optional(t.string({ maxLength: 1000, description: `Only records whose ${f.name} equals this` }));
  }
  // Operator filters arrive as extra query keys: ?value[gte]=1000, ?stage[in]=a,b.
  const filterKey = t.string({ maxLength: 1000, description: "Filter as field[op]=value, e.g. value[gte]=1000; ops eq ne gt gte lt lte in contains isNull" });
  const listQuery = t.object({
    filter: t.optional(t.string({ maxLength: 20_000, description: 'JSON: {"field": {"op": value}}; ops eq ne gt gte lt lte in contains isNull' })),
    sort: t.optional(t.string({ maxLength: 100, description: `One of ${sortableKeys(r).join(", ")}; - prefix for descending` })),
    cursor: t.optional(t.string({ maxLength: 4000, description: "nextCursor from the previous page" })),
    limit: t.optional(t.integer({ min: 1, max: 200 })),
    q: t.optional(t.string({ maxLength: 500, description: "Full-text search" })),
    fields: t.optional(t.string({ maxLength: 2000, description: "Comma-separated fields to return" })),
    view: Object.keys(r.views).length ? t.optional(t.string({ maxLength: 100, description: `Saved view: ${Object.keys(r.views).join(", ")}` })) : t.optional(t.string({ maxLength: 100 })),
    include: t.optional(t.string({ maxLength: 500, description: "Comma-separated relation fields to embed" })),
    ...fieldQuery,
  }, { rest: filterKey });
  const { cursor: _cursor, limit: _limit, ...exportShape } = listQuery.shape;
  const exportQuery = t.object(exportShape, { rest: filterKey });
  const idParams = t.object({ id: t.string({ minLength: 1, maxLength: 200 }) });
  const one = t.object({ fields: t.optional(t.string({ maxLength: 2000 })), include: t.optional(t.string({ maxLength: 500 })) });
  const withPerm = (p: string | undefined) => (p ? { permission: p } : {});
  const repoFor = async (ctx: Context) => new Repo(await env.runtime(ctx), r, scopeFor(r, ctx));
  const fieldNames = Object.keys(r.fields).join(", ");

  const routes: RouteDef[] = [
    route.get(base, {
      name: `${r.name}_list`,
      summary: `List ${r.label.toLowerCase()} with filters, sort, search and cursor pagination`,
      description: listDescription(r),
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.read),
      query: listQuery,
      response: t.object({ items: t.array(record), nextCursor: t.nullable(t.string()) }),
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        const q = ctx.query as ListQuery;
        const spec = resolveList(r, c, q);
        const include = checkInclude(r, env, c, parseList(q.include, "include"));
        const repo = await repoFor(c);
        const page = await repo.list({ filter: spec.filter, sort: spec.sort, cursor: q.cursor, limit: q.limit, q: spec.q });
        const items = visible(r, c, page.items);
        if (include.length) await repo.include(items, include, includeCheck(c));
        return { items: items.map((rec) => pick(rec, spec.fields)), nextCursor: page.nextCursor };
      },
    }),
    route.get(`${base}/:id`, {
      name: `${r.name}_get`,
      summary: `Get one ${r.singular.toLowerCase()} by id`,
      description: `Returns the record. \`fields\` limits the keys; \`include\` embeds relations. Fields:\n${describeFields(r)}`,
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.read),
      params: idParams,
      query: one,
      response: record,
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        const fields = parseList(ctx.query.fields, "fields");
        checkFields(r, fields);
        const include = checkInclude(r, env, c, parseList(ctx.query.include, "include"));
        const repo = await repoFor(c);
        const rec = await repo.get(ctx.params.id);
        if (!rec) throw adminErrors.notFound(r.name, ctx.params.id);
        if (perm) authorizeOf(c)?.(perm.read, rec);
        if (include.length) await repo.include([rec], include, includeCheck(c));
        return pick(rec, fields);
      },
    }),
    route.post(base, {
      name: `${r.name}_create`,
      summary: `Create a ${r.singular.toLowerCase()}`,
      description: `Body fields: ${fieldNames}. Unknown keys are ignored; ids, timestamps and the organization are set by the server.\n${describeFields(r)}`,
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.create),
      body: createSchema(r),
      response: record,
      status: 201,
      handler: async (ctx) => (await repoFor(ctx as unknown as Context)).create(ctx.body as Record<string, unknown>),
    }),
    route.patch(`${base}/:id`, {
      name: `${r.name}_update`,
      summary: `Update some fields of a ${r.singular.toLowerCase()}`,
      description: `Send only the fields to change; null clears an optional field. Emits ${r.name}.updated with the changed field names.\n${describeFields(r)}`,
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.update),
      params: idParams,
      body: updateSchema(r),
      response: record,
      handler: async (ctx) => (await repoFor(ctx as unknown as Context)).update(ctx.params.id, ctx.body as Record<string, unknown>),
    }),
    route.delete(`${base}/:id`, {
      name: `${r.name}_delete`,
      summary: `Delete a ${r.singular.toLowerCase()}${r.softDelete ? " (soft delete: hidden, kept for audit)" : ""}`,
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.delete),
      params: idParams,
      handler: async (ctx) => {
        await (await repoFor(ctx as unknown as Context)).remove(ctx.params.id);
      },
    }),
    route.post(`${base}/bulk`, {
      name: `${r.name}_bulk`,
      annotations: { destructiveHint: true },
      summary: `Update or delete many ${r.label.toLowerCase()} at once (all or nothing)`,
      description: `action "update" applies \`changes\` to every id; action "delete" deletes them. Up to 500 ids. If any id is missing, nothing is written.`,
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.update),
      body: t.object({
        action: t.enum(["update", "delete"]),
        ids: t.array(t.string({ minLength: 1, maxLength: 200 }), { min: 1, max: 500 }),
        changes: t.optional(updateSchema(r)),
      }),
      response: t.object({ action: t.string(), count: t.integer(), ids: t.array(t.string()) }),
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        const { action, changes } = ctx.body;
        const ids = [...new Set(ctx.body.ids as string[])];
        if (action === "delete" && perm) authorizeOf(c)?.(perm.delete);
        if (action === "update" && (!changes || Object.keys(changes).length === 0)) {
          throw errors.badRequest('Bulk update needs changes', 'Send { "action": "update", "ids": [...], "changes": { "stage": "customer" } }.');
        }
        const repo = await repoFor(c);
        const rows = await repo.findRows(ids);
        const byId = new Map(rows.map((row) => [row.id as string, row]));
        const missing = ids.find((id) => !byId.has(id));
        if (missing !== undefined) throw adminErrors.notFound(r.name, missing);
        const prepared = [];
        for (const id of ids) prepared.push(action === "delete" ? await repo.prepareDelete(id, byId.get(id)) : await repo.prepareUpdate(id, changes!, byId.get(id)));
        await repo.run(prepared);
        return { action, count: ids.length, ids };
      },
    }),
    route.get(`${base}/export.csv`, {
      name: `${r.name}_export`,
      responseType: "text/csv",
      summary: `Export ${r.label.toLowerCase()} as CSV (same filters as list)`,
      description: `Streams text/csv with a header row. Accepts filter, sort, q, view and fields like the list route. Money is in major units (12.50). Cells starting with = + - @ are prefixed with ' so spreadsheets do not run them.`,
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.export),
      query: exportQuery,
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        const spec = resolveList(r, c, ctx.query as ListQuery);
        const repo = await repoFor(c);
        const columns = exportColumns(r, spec.fields);
        const size = env.exportPageSize;
        // The first page is read before responding, so bad filters are a clean 400.
        let page = await repo.list({ filter: spec.filter, sort: spec.sort, q: spec.q, limit: size });
        let count = 0;
        let done = false;
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(exportHeader(columns)));
          },
          async pull(controller) {
            if (done) return;
            try {
              const items = visible(r, c, page.items);
              count += items.length;
              if (items.length) controller.enqueue(enc.encode(items.map((rec) => exportLine(r, columns, rec)).join("")));
              if (page.nextCursor) {
                page = await repo.list({ filter: spec.filter, sort: spec.sort, q: spec.q, limit: size, cursor: page.nextCursor });
              } else {
                done = true;
                await repo.audit("export", null, undefined, undefined, { count, filter: spec.filter, q: spec.q ?? null, columns });
                controller.close();
              }
            } catch (err) {
              controller.error(err);
            }
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${r.name}.csv"`,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          },
        });
      },
    }),
    route.post(`${base}/import`, {
      name: `${r.name}_import`,
      annotations: { destructiveHint: true },
      summary: `Import ${r.label.toLowerCase()} from CSV (validate every row; dryRun to preview)`,
      description: `Send { csv, mapping?, dryRun? } as JSON, or a multipart upload with a \`file\`. The header row is matched to fields by name or label; \`mapping\` maps other headers ({"Full name": "name"}, null to skip). dryRun returns per-row errors without writing; otherwise all rows are inserted in one batch, or none if any row is invalid. Relations accept an id or the target's title. Max ${env.importMaxRows} rows.\nFields:\n${describeFields(r)}`,
      tags,
      mcp,
      auth: "required",
      ...withPerm(perm?.import),
      body: t.object({
        csv: t.optional(t.string({ description: "CSV text with a header row" })),
        file: t.optional(t.any({ description: "CSV file (multipart upload)" })),
        mapping: t.optional(t.union([t.record(t.nullable(t.string())), t.string()])),
        dryRun: t.optional(t.boolean()),
      }),
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        if (perm) authorizeOf(c)?.(perm.create);
        const b = ctx.body as { csv?: string; file?: unknown; mapping?: Record<string, string | null> | string; dryRun?: boolean };
        let csv = b.csv;
        if (csv === undefined && b.file && typeof (b.file as Blob).text === "function") csv = await (b.file as Blob).text();
        if (csv === undefined) throw adminErrors.importEmpty();
        let mapping = b.mapping;
        if (typeof mapping === "string") {
          try {
            mapping = JSON.parse(mapping) as Record<string, string | null>;
          } catch {
            throw errors.badRequest("mapping is not valid JSON", 'Send mapping as an object: {"Full name": "name"}.');
          }
          const check = validate(t.record(t.nullable(t.string())), mapping);
          if (!check.ok) throw errors.validation("body.mapping", check.issues);
        }
        const repo = await repoFor(c);
        const rt = await env.runtime(c);
        return runImport(repo, rt, { csv, mapping: mapping as Record<string, string | null> | undefined, dryRun: b.dryRun, maxRows: env.importMaxRows });
      },
    }),
  ];

  const actionNames = Object.keys(r.actions);
  if (actionNames.length) {
    const max = Math.max(...Object.values(r.actions).map((a) => a.maxRecords));
    routes.push(
      route.post(`${base}/actions/:action`, {
        name: `${r.name}_action`,
        summary: `Run an action on ${r.label.toLowerCase()}: ${actionNames.join(", ")}`,
        description: Object.values(r.actions)
          .map((a) => `- ${a.name}: ${a.label} (needs ${a.permission}${a.input ? `; input: ${JSON.stringify(a.input.json)}` : ""})`)
          .join("\n"),
        tags,
        mcp,
        auth: "required",
        ...withPerm(perm?.read),
        params: t.object({ action: t.string({ maxLength: 100 }) }),
        body: t.object({ ids: t.array(t.string({ minLength: 1, maxLength: 200 }), { max }), input: t.optional(t.unknown()) }),
        response: t.object({ action: t.string(), count: t.integer(), result: t.unknown() }),
        handler: async (ctx) => {
          const c = ctx as unknown as Context;
          const action = Object.prototype.hasOwnProperty.call(r.actions, ctx.params.action) ? r.actions[ctx.params.action] : undefined;
          if (!action) throw adminErrors.actionUnknown(r.name, ctx.params.action, actionNames);
          const authorize = authorizeOf(c);
          if (action.permission && authorize) authorize(action.permission);
          const ids = [...new Set(ctx.body.ids as string[])];
          if (ids.length > action.maxRecords) throw errors.badRequest(`${action.name} accepts at most ${action.maxRecords} records`, "Send fewer ids per call.");
          let input: unknown = ctx.body.input;
          if (action.input) {
            const checked = validate(action.input, input);
            if (!checked.ok) throw errors.validation("body.input", checked.issues);
            input = checked.value;
          }
          const repo = await repoFor(c);
          const rows = await repo.findRows(ids);
          const byId = new Map(rows.map((row) => [row.id as string, repo.toRecord(row)]));
          const missing = ids.find((id) => !byId.has(id));
          if (missing !== undefined) throw adminErrors.notFound(r.name, missing);
          const records = ids.map((id) => byId.get(id)!);
          if (action.permission && authorize) for (const rec of records) authorize(action.permission, rec);
          const result = await action.run({ records, input, ctx: c, data: repo.data() });
          await repo.auditMany(records.map((rec) => ({ action: `action.${action.name}`, resource: r.name, resourceId: rec.id, ...(input === undefined ? {} : { metadata: { input } }) })));
          return { action: action.name, count: records.length, result: result ?? null };
        },
      }),
    );
  }
  return routes;
}

export function schemaRoute(env: RouteEnv): RouteDef {
  return route.get(`${env.basePath}/_admin/schema`, {
    name: "admin_schema",
    summary: "Describe the admin resources you can access: fields, filters, views, actions and permissions",
    description: "Use it to learn which resources, fields (with types, options and filter operators), views and actions exist before calling the <resource>_list/_create/_update tools.",
    tags: ["admin"],
    auth: "required",
    handler: (ctx) => {
      const can = canOf(ctx as unknown as Context);
      const schema: AdminSchema = adminSchema(env.resources, { basePath: env.basePath, ...(can ? { can: (p: string) => can(p) } : {}) });
      return schema as unknown as Record<string, unknown>;
    },
  });
}
