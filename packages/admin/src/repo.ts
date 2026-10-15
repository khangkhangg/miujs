// The data layer behind routes, actions, hooks and workflow actions. Every statement is scoped:
// tenant resources always filter by org_id (from the caller's verified org, never the input),
// soft-deleted rows are invisible, and identifiers come only from the resource definition.

import { quoteIdent, type Database, type Statement } from "@miujs/db";
import { errors, validate, type Context, type Env, type Schema } from "miujs";
import { adminErrors } from "./errors.ts";
import { fromDb, toDb } from "./fields.ts";
import { filterClauses, encodeCursor, parseSort, searchClause, sortSql, splitSort, resolveRelative, type Clause } from "./query.ts";
import { createSchema, updateSchema, type AdminRecord, type DataAccess, type Filter, type HookArgs, type Resource } from "./resource.ts";

export interface Scope {
  /** The verified active org (tenant resources need it). */
  orgId: string | null;
  userId: string | null;
  ctx?: Context;
  env: Env;
  /** Row-level check (ctx.authorize from @miujs/access). Absent for system calls. */
  authorize?: (permission: string, record: AdminRecord) => void;
}

export interface Runtime {
  db: Database;
  byName: Map<string, Resource>;
  emit(event: string, data: Record<string, unknown>, scope: Scope): Promise<void>;
  log(message: string, data: Record<string, unknown>): void;
  now(): number;
  /** Audit sink for writes made outside a request (the audit service, as a system actor). */
  auditOutside?(entries: AuditEntryIn[], scope: Scope): Promise<void>;
}

export interface AuditEntryIn {
  action: string;
  resource: string;
  resourceId: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ListOptions {
  filter?: Filter;
  sort?: string;
  cursor?: string;
  limit?: number;
  q?: string;
}

export interface Prepared {
  statements: Statement[];
  /** The record id to read back after the write (run() reads them all in a few queries). */
  readBack?: string;
  /** After the statements committed: hooks, audit, events. Returns the record. */
  commit(record?: AdminRecord | null): Promise<AdminRecord | null>;
}

type Row = Record<string, unknown>;

/** Validates data-API input like the HTTP routes do (unknown and readOnly keys are dropped). */
function checked(schema: Schema<any>, value: unknown): Record<string, unknown> {
  const r = validate(schema, value ?? {});
  if (!r.ok) throw errors.validation("data", r.issues);
  return r.value as Record<string, unknown>;
}

const SYSTEM_OUT: [string, string][] = [
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
  ["created_by", "createdBy"],
  ["updated_by", "updatedBy"],
];

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Maps SQLite/D1 constraint errors to admin errors; rethrows anything else. */
export function mapDbError(r: Resource, err: unknown): never {
  const msg = String((err as Error)?.message ?? err);
  const unique = /UNIQUE constraint failed: ([^:]+?)(?::|$)/.exec(msg);
  if (unique) {
    const cols = unique[1].split(",").map((s) => s.trim().split(".").pop()!);
    const col = cols[cols.length - 1];
    const f = Object.values(r.fields).find((x) => x.column === col);
    throw adminErrors.unique(r.name, f?.name ?? col);
  }
  if (/FOREIGN KEY constraint failed/.test(msg)) {
    throw adminErrors.inUse(r.name);
  }
  throw err;
}

export class Repo {
  readonly r: Resource;
  private rt: Runtime;
  private scope: Scope;
  /** While run() commits a batch, audit entries collect here and go out with one logMany. */
  private auditBuffer: AuditEntryIn[] | null = null;
  /** Relation targets already checked while preparing a batch (bulk and import repeat them). */
  private relationsSeen = new Set<string>();

  constructor(rt: Runtime, r: Resource, scope: Scope) {
    this.rt = rt;
    this.r = r;
    this.scope = scope;
  }

  private get table(): string {
    return quoteIdent(this.r.table);
  }

  private orgId(): string | null {
    if (this.r.tenant !== "org") return null;
    if (!this.scope.orgId) {
      // Defensive: routes resolve the org with tenantScope() first, so this means a caller bug.
      throw adminErrors.noTenant(this.r.name);
    }
    return this.scope.orgId;
  }

  /**
   * org_id and deleted_at conditions every statement carries. `byId`: the statement looks rows
   * up by id; the unary + keeps SQLite on the primary key (without it, and without ANALYZE
   * statistics, it reads an (org_id, ...) index instead: every row of the organization, ~15 ms per
   * lookup at 100k rows).
   */
  private base(byId = false): Clause[] {
    const out: Clause[] = [];
    const org = this.orgId();
    if (org !== null) out.push({ sql: byId ? `+"org_id" = ?` : `"org_id" = ?`, binds: [org] });
    if (this.r.softDelete) out.push({ sql: `"deleted_at" IS NULL`, binds: [] });
    return out;
  }

  private where(clauses: Clause[]): { sql: string; binds: unknown[] } {
    if (clauses.length === 0) return { sql: "", binds: [] };
    return { sql: ` WHERE ${clauses.map((c) => c.sql).join(" AND ")}`, binds: clauses.flatMap((c) => c.binds) };
  }

  toRecord(row: Row): AdminRecord {
    const out: Record<string, unknown> = { id: row.id };
    for (const f of Object.values(this.r.fields)) out[f.name] = fromDb(f, row[f.column]);
    if (this.r.timestamps) {
      for (const [col, key] of SYSTEM_OUT) {
        const v = row[col];
        out[key] = col.endsWith("_at") ? (v === null || v === undefined ? null : new Date(Number(v)).toISOString()) : (v ?? null);
      }
    }
    return out as AdminRecord;
  }

  async findRow(id: string): Promise<Row | null> {
    const w = this.where([{ sql: `"id" = ?`, binds: [id] }, ...this.base(true)]);
    return this.rt.db.prepare(`SELECT * FROM ${this.table}${w.sql}`).bind(...w.binds).first<Row>();
  }

  async findRows(ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    const out: Row[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const w = this.where([{ sql: `"id" IN (${chunk.map(() => "?").join(", ")})`, binds: chunk }, ...this.base(true)]);
      const { results } = await this.rt.db.prepare(`SELECT * FROM ${this.table}${w.sql}`).bind(...w.binds).all<Row>();
      out.push(...results);
    }
    return out;
  }

  async get(id: string): Promise<AdminRecord | null> {
    const row = await this.findRow(id);
    return row ? this.toRecord(row) : null;
  }

  async list(o: ListOptions = {}): Promise<{ items: AdminRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, o.limit ?? 50), 1000);
    const sort = parseSort(this.r, o.sort);
    const clauses = [...this.base(), ...filterClauses(this.r, o.filter ?? {}, this.rt.now())];
    const search = searchClause(this.r, o.q);
    if (search) clauses.push(search);
    const page = async (orderBy: string, extra: Clause | null, n: number) => {
      const w = this.where(extra ? [...clauses, extra] : clauses);
      return (await this.rt.db.prepare(`SELECT * FROM ${this.table}${w.sql} ORDER BY ${orderBy} LIMIT ?`).bind(...w.binds, n).all<Row>()).results;
    };
    let results: Row[];
    if (sort.column === "id" || sort.notNull) {
      const { orderBy, after } = sortSql(sort, o.cursor);
      results = await page(orderBy, after, limit + 1);
    } else {
      // Values, then NULLs: two range reads on the (org, field, id) index instead of a full sort.
      const plan = splitSort(sort, o.cursor);
      results = plan.values ? await page(plan.values.orderBy, plan.values.where, limit + 1) : [];
      if (results.length < limit + 1) results = results.concat(await page(plan.nulls.orderBy, plan.nulls.where, limit + 1 - results.length));
    }
    const more = results.length > limit;
    const rows = more ? results.slice(0, limit) : results;
    return { items: rows.map((row) => this.toRecord(row)), nextCursor: more ? encodeCursor(sort, rows[rows.length - 1]) : null };
  }

  /** A repo for another resource with the same caller and org. */
  sibling(target: Resource): Repo {
    return new Repo(this.rt, target, this.scope);
  }

  private hookArgs(): HookArgs {
    return { resource: this.r, ctx: this.scope.ctx, data: this.data(), orgId: this.scope.orgId, userId: this.scope.userId };
  }

  /** Scoped access to other resources, as the same caller. */
  data(): DataAccess {
    return (name: string) => {
      const target = this.rt.byName.get(name);
      if (!target) throw adminErrors.resourceUnknown(name, [...this.rt.byName.keys()]);
      return new Repo(this.rt, target, { ...this.scope, authorize: undefined }).client();
    };
  }

  client(): ReturnType<DataAccess> {
    return {
      get: (id) => this.get(id),
      list: (q) => this.list(q),
      create: async (data) => this.create(checked(createSchema(this.r), data)),
      update: async (id, changes) => this.update(id, checked(updateSchema(this.r), changes)),
      delete: async (id) => void (await this.remove(id)),
    };
  }

  /** Relation values must name a live record visible in the same org. */
  async checkRelations(values: Record<string, unknown>): Promise<void> {
    for (const f of Object.values(this.r.fields)) {
      if (f.type !== "relation") continue;
      const v = values[f.name];
      if (v === undefined || v === null) continue;
      const target = this.rt.byName.get(f.options.target!)!;
      const key = `${target.name} ${String(v)}`;
      if (this.relationsSeen.has(key)) continue;
      const found = await new Repo(this.rt, target, this.scope).findRow(String(v));
      if (!found) throw adminErrors.relationInvalid(this.r.name, f.name, target.name, v);
      this.relationsSeen.add(key);
    }
  }

  /** Fills defaults that depend on the caller or the clock, and those of readOnly fields. */
  private withDefaults(input: Record<string, unknown>): Record<string, unknown> {
    const out = { ...input };
    for (const f of Object.values(this.r.fields)) {
      if (out[f.name] !== undefined) continue;
      const d = f.options.default;
      if (d === undefined) continue;
      if (f.type === "user" && d === "currentUser") out[f.name] = this.scope.userId;
      else if (f.type === "date" || f.type === "datetime") out[f.name] = resolveRelative(f.type, d, this.rt.now());
      else out[f.name] = typeof d === "object" && d !== null ? structuredClone(d) : d;
    }
    return out;
  }

  private known(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (Object.prototype.hasOwnProperty.call(this.r.fields, k) && v !== undefined) out[k] = v;
    return out;
  }

  async prepareCreate(input: Record<string, unknown>): Promise<Prepared & { id: string }> {
    let values = this.withDefaults(this.known(input));
    if (this.r.hooks.beforeCreate) {
      const replaced = await this.r.hooks.beforeCreate({ ...this.hookArgs(), input: values });
      if (replaced) values = this.known(replaced);
    }
    for (const f of Object.values(this.r.fields)) {
      if (f.options.required && (values[f.name] === undefined || values[f.name] === null)) {
        throw adminErrors.validation([{ path: `body.${f.name}`, message: "is required" }]);
      }
    }
    // Row-level "create" policies see the record as it will be written (e.g. its owner).
    if (this.r.permissions) this.scope.authorize?.(this.r.permissions.create, { id: "", ...values } as AdminRecord);
    await this.checkRelations(values);
    const id = crypto.randomUUID();
    const cols: string[] = ["id"];
    const binds: unknown[] = [id];
    const org = this.orgId();
    if (org !== null) {
      cols.push("org_id");
      binds.push(org);
    }
    for (const f of Object.values(this.r.fields)) {
      if (values[f.name] === undefined) continue;
      cols.push(f.column);
      binds.push(toDb(f, values[f.name]));
    }
    if (this.r.timestamps) {
      const now = this.rt.now();
      cols.push("created_at", "updated_at", "created_by", "updated_by");
      binds.push(now, now, this.scope.userId, this.scope.userId);
    }
    const stmt = this.rt.db.prepare(`INSERT INTO ${this.table} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...binds);
    return {
      id,
      statements: [stmt],
      readBack: id,
      commit: async (read) => {
        const record = read ?? (await this.get(id))!;
        await this.r.hooks.afterCreate?.({ ...this.hookArgs(), record });
        await this.audit("create", id, undefined, record);
        await this.rt.emit(`${this.r.name}.created`, this.event({ id, record }), this.scope);
        return record;
      },
    };
  }

  async prepareUpdate(id: string, changes: Record<string, unknown>, row?: Row | null): Promise<Prepared> {
    const current = row === undefined ? await this.findRow(id) : row;
    if (!current) throw adminErrors.notFound(this.r.name, id);
    const before = this.toRecord(current);
    if (this.r.permissions) this.scope.authorize?.(this.r.permissions.update, before);
    let values = this.known(changes);
    if (this.r.hooks.beforeUpdate) {
      const replaced = await this.r.hooks.beforeUpdate({ ...this.hookArgs(), before, changes: values });
      if (replaced) values = this.known(replaced);
    }
    const changed: string[] = [];
    const sets: string[] = [];
    const binds: unknown[] = [];
    for (const [k, v] of Object.entries(values)) {
      const f = this.r.fields[k];
      if (f.options.required && v === null) throw adminErrors.validation([{ path: `body.${k}`, message: "cannot be null" }]);
      const dbv = toDb(f, v);
      if (same(dbv, current[f.column])) continue;
      changed.push(k);
      sets.push(`${quoteIdent(f.column)} = ?`);
      binds.push(dbv);
    }
    if (changed.length === 0) return { statements: [], commit: async () => before };
    await this.checkRelations(Object.fromEntries(changed.map((k) => [k, values[k]])));
    if (this.r.timestamps) {
      sets.push(`"updated_at" = ?`, `"updated_by" = ?`);
      binds.push(this.rt.now(), this.scope.userId);
    }
    const w = this.where([{ sql: `"id" = ?`, binds: [id] }, ...this.base(true)]);
    const stmt = this.rt.db.prepare(`UPDATE ${this.table} SET ${sets.join(", ")}${w.sql}`).bind(...binds, ...w.binds);
    return {
      statements: [stmt],
      readBack: id,
      commit: async (read) => {
        const record = read ?? (await this.get(id))!;
        await this.r.hooks.afterUpdate?.({ ...this.hookArgs(), before, record, changed });
        await this.audit("update", id, before, record);
        const pick = (rec: AdminRecord) => Object.fromEntries(changed.map((k) => [k, rec[k]]));
        await this.rt.emit(`${this.r.name}.updated`, this.event({ id, record, before: pick(before), changes: changed }), this.scope);
        return record;
      },
    };
  }

  async prepareDelete(id: string, row?: Row | null): Promise<Prepared> {
    const current = row === undefined ? await this.findRow(id) : row;
    if (!current) throw adminErrors.notFound(this.r.name, id);
    const record = this.toRecord(current);
    if (this.r.permissions) this.scope.authorize?.(this.r.permissions.delete, record);
    await this.r.hooks.beforeDelete?.({ ...this.hookArgs(), record });
    const w = this.where([{ sql: `"id" = ?`, binds: [id] }, ...this.base(true)]);
    const soft = this.r.softDelete;
    let stmt: Statement;
    if (soft) {
      const sets = [`"deleted_at" = ?`];
      const binds: unknown[] = [this.rt.now()];
      if (this.r.timestamps) {
        sets.push(`"updated_at" = ?`, `"updated_by" = ?`);
        binds.push(this.rt.now(), this.scope.userId);
      }
      stmt = this.rt.db.prepare(`UPDATE ${this.table} SET ${sets.join(", ")}${w.sql}`).bind(...binds, ...w.binds);
    } else {
      stmt = this.rt.db.prepare(`DELETE FROM ${this.table}${w.sql}`).bind(...w.binds);
    }
    return {
      statements: [stmt],
      commit: async () => {
        await this.r.hooks.afterDelete?.({ ...this.hookArgs(), record, soft });
        await this.audit("delete", id, record, undefined);
        await this.rt.emit(`${this.r.name}.deleted`, this.event({ id, record, soft }), this.scope);
        return null;
      },
    };
  }

  /** Runs prepared writes in one batch (one transaction), then their commits in order. */
  async run(prepared: Prepared[]): Promise<(AdminRecord | null)[]> {
    const statements = prepared.flatMap((p) => p.statements);
    if (statements.length) {
      try {
        if (statements.length === 1) await statements[0].run();
        else await this.rt.db.batch(statements);
      } catch (err) {
        mapDbError(this.r, err);
      }
    }
    this.relationsSeen.clear();
    // Written records are read back together (chunks of 90 ids), not one SELECT each.
    const ids = prepared.map((p) => p.readBack).filter((x): x is string => typeof x === "string");
    const read = new Map<string, AdminRecord>();
    if (ids.length > 1) for (const row of await this.findRows(ids)) read.set(row.id as string, this.toRecord(row));
    const out: (AdminRecord | null)[] = [];
    this.auditBuffer = [];
    try {
      for (const p of prepared) out.push(await p.commit(p.readBack ? read.get(p.readBack) : undefined));
    } finally {
      const entries = this.auditBuffer;
      this.auditBuffer = null;
      await this.auditMany(entries);
    }
    return out;
  }

  async create(input: Record<string, unknown>): Promise<AdminRecord> {
    return (await this.run([await this.prepareCreate(input)]))[0]!;
  }

  async update(id: string, changes: Record<string, unknown>): Promise<AdminRecord> {
    return (await this.run([await this.prepareUpdate(id, changes)]))[0]!;
  }

  async remove(id: string): Promise<void> {
    await this.run([await this.prepareDelete(id)]);
  }

  private event(extra: Record<string, unknown>): Record<string, unknown> {
    return { resource: this.r.name, orgId: this.r.tenant === "org" ? this.scope.orgId : null, actor: this.scope.userId, at: new Date(this.rt.now()).toISOString(), ...extra };
  }

  async audit(action: string, id: string | null, before: unknown, after: unknown, metadata?: Record<string, unknown>): Promise<void> {
    const entry: AuditEntryIn = { action, resource: this.r.name, resourceId: id, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(metadata ? { metadata } : {}) };
    if (this.auditBuffer) this.auditBuffer.push(entry);
    else await this.auditMany([entry]);
  }

  /** Writes entries as consecutive audit rows: ctx.audit in a request, the audit service outside one. */
  async auditMany(entries: AuditEntryIn[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      if (this.scope.ctx) {
        const client = (this.scope.ctx as { audit?: { log(e: unknown): Promise<unknown>; logMany?(e: unknown[]): Promise<unknown> } }).audit;
        if (!client || typeof client.log !== "function") return;
        if (typeof client.logMany === "function") await client.logMany(entries);
        else for (const e of entries) await client.log(e);
        return;
      }
      await this.rt.auditOutside?.(entries, this.scope);
    } catch (err) {
      this.rt.log("admin: audit log failed", { err, resource: this.r.name, count: entries.length });
    }
  }

  /**
   * Adds `_included: { field: record | null }` for the given relation fields. `visible` is the
   * caller's row-level read check: a related record it rejects is embedded as null.
   */
  async include(records: AdminRecord[], names: string[], visible?: (target: Resource, rec: AdminRecord) => boolean): Promise<void> {
    for (const name of names) {
      const f = this.r.fields[name];
      const target = this.rt.byName.get(f.options.target!)!;
      const ids = [...new Set(records.map((rec) => rec[name]).filter((v): v is string => typeof v === "string"))];
      const repo = new Repo(this.rt, target, this.scope);
      const rows = await repo.findRows(ids);
      const byId = new Map<string, AdminRecord>();
      for (const row of rows) {
        const rec = repo.toRecord(row);
        if (!visible || visible(target, rec)) byId.set(rec.id, rec);
      }
      for (const rec of records) {
        const inc = ((rec as Record<string, unknown>)._included ??= {}) as Record<string, unknown>;
        inc[name] = typeof rec[name] === "string" ? (byId.get(rec[name] as string) ?? null) : null;
      }
    }
  }
}
