// `@miujs/admin/crm`: ready-made CRM resources (companies, contacts, deals, activities, tasks),
// a record timeline, workflow actions and example JSON workflows, wired by crm().

import { errors, route, t, type Context, type Env, type RouteDef } from "miujs";
import { defineAction, fromJson, type ActionContext, type ActionDef, type WorkflowDef, type WorkflowSpec } from "@miujs/workflows";
import { adminErrors } from "./errors.ts";
import { field } from "./fields.ts";
import { admin, type AdminOptions, type AdminPlugin } from "./plugin.ts";
import { Repo } from "./repo.ts";
import { resource, type AdminRecord, type DataAccess, type HookArgs, type Resource } from "./resource.ts";
import { scopeFor } from "./routes.ts";

export interface CrmResourceOptions {
  /** Currency of contact values and deal amounts. Default "USD". */
  currency?: string;
}

const DEAL_STAGES = [
  { value: "lead", label: "Lead", probability: 10 },
  { value: "qualified", label: "Qualified", probability: 25 },
  { value: "proposal", label: "Proposal", probability: 50 },
  { value: "negotiation", label: "Negotiation", probability: 75 },
  { value: "won", label: "Won", probability: 100, color: "green" },
  { value: "lost", label: "Lost", probability: 0, color: "gray" },
];
const SUBJECTS = ["companies", "contacts", "deals"];

/** Polymorphic links (`subjectType` + `subjectId`) must point at a live record in the same org. */
async function checkSubject(args: HookArgs, values: Record<string, unknown>, resourceName: string): Promise<void> {
  const type = values.subjectType;
  const id = values.subjectId;
  if (type === undefined || type === null || id === undefined || id === null) {
    if ((type === undefined || type === null) !== (id === undefined || id === null)) {
      throw errors.badRequest("subjectType and subjectId go together", "Send both (to link a record) or neither.");
    }
    return;
  }
  const found = await args.data(String(type)).get(String(id));
  if (!found) throw adminErrors.relationInvalid(resourceName, "subjectId", String(type), id);
}

/** The five CRM resources. Pass them (or your own) to admin(), or use crm(). */
export function crmResources(o: CrmResourceOptions = {}): Resource[] {
  const currency = o.currency ?? "USD";
  const companies = resource("companies", {
    label: "Companies",
    fields: {
      name: field.text({ required: true, max: 200, searchable: true }),
      domain: field.text({ max: 253, searchable: true, help: "e.g. acme.com" }),
      website: field.url(),
      industry: field.select(["software", "finance", "healthcare", "retail", "manufacturing", "education", "other"]),
      size: field.select(["1-10", "11-50", "51-200", "201-1000", "1000+"]),
      phone: field.phone(),
      address: field.longText(),
      tags: field.tags(),
      notes: field.richText(),
      owner: field.user({ default: "currentUser" }),
    },
    tenant: "org",
    softDelete: true,
    search: true,
    views: { mine: { label: "By industry", kind: "kanban", groupBy: "industry" } },
  });
  const contacts = resource("contacts", {
    label: "Contacts",
    fields: {
      name: field.text({ required: true, max: 200, searchable: true }),
      email: field.email({ unique: true, searchable: true }),
      phone: field.phone({ searchable: true }),
      company: field.relation("companies", { onDelete: "set null" }),
      stage: field.select(["lead", "qualified", "customer", "lost"], { default: "lead" }),
      value: field.money({ currency }),
      tags: field.tags(),
      notes: field.richText(),
      nextFollowUp: field.date({ index: true }),
      owner: field.user({ default: "currentUser" }),
    },
    tenant: "org",
    softDelete: true,
    search: true,
    views: {
      pipeline: { kind: "kanban", groupBy: "stage" },
      upcoming: { filter: { nextFollowUp: { gte: "today" } }, sort: "nextFollowUp" },
    },
    actions: {
      markLost: {
        label: "Mark lost",
        confirm: "Mark the selected contacts as lost?",
        run: async ({ records, data }) => {
          for (const r of records) await data("contacts").update(r.id, { stage: "lost" });
          return { updated: records.length };
        },
      },
    },
  });
  const probabilityFor = (stage: unknown) => DEAL_STAGES.find((s) => s.value === stage)?.probability;
  const closed = (stage: unknown) => stage === "won" || stage === "lost";
  const deals = resource("deals", {
    label: "Deals",
    fields: {
      title: field.text({ required: true, max: 200, searchable: true }),
      company: field.relation("companies", { onDelete: "set null" }),
      contact: field.relation("contacts", { onDelete: "set null" }),
      stage: field.select(DEAL_STAGES, { default: "lead" }),
      amount: field.money({ currency }),
      probability: field.percent({ help: "Defaults to the stage's probability" }),
      expectedClose: field.date({ index: true }),
      closedAt: field.datetime({ readOnly: true }),
      owner: field.user({ default: "currentUser" }),
      notes: field.richText(),
    },
    tenant: "org",
    softDelete: true,
    search: true,
    views: {
      pipeline: { kind: "kanban", groupBy: "stage" },
      closingSoon: { label: "Closing soon", filter: { expectedClose: { lte: "today+30d" }, stage: { in: ["lead", "qualified", "proposal", "negotiation"] } }, sort: "expectedClose" },
    },
    actions: {
      markWon: { label: "Mark won", run: async ({ records, data }) => Promise.all(records.map((r) => data("deals").update(r.id, { stage: "won" }))).then((x) => ({ updated: x.length })) },
      markLost: { label: "Mark lost", run: async ({ records, data }) => Promise.all(records.map((r) => data("deals").update(r.id, { stage: "lost" }))).then((x) => ({ updated: x.length })) },
    },
    hooks: {
      beforeCreate: ({ input }) => {
        const stage = input.stage ?? "lead";
        return { ...input, probability: input.probability ?? probabilityFor(stage) ?? null, closedAt: closed(stage) ? new Date().toISOString() : null };
      },
      beforeUpdate: ({ before, changes }) => {
        if (changes.stage === undefined || changes.stage === before.stage) return changes;
        const out: Record<string, unknown> = { ...changes };
        if (changes.probability === undefined) out.probability = probabilityFor(changes.stage) ?? null;
        out.closedAt = closed(changes.stage) ? new Date().toISOString() : null;
        return out;
      },
    },
  });
  const activities = resource("activities", {
    label: "Activities",
    singular: "Activity",
    fields: {
      type: field.select(["call", "email", "meeting", "note"], { required: true, default: "note" }),
      subject: field.text({ required: true, max: 300, searchable: true }),
      body: field.richText({ searchable: true }),
      subjectType: field.select(SUBJECTS, { required: true, label: "Linked to" }),
      subjectId: field.text({ required: true, index: true, label: "Linked record" }),
      occurredAt: field.datetime({ default: "now" }),
      durationMinutes: field.number({ integer: true, min: 0 }),
      owner: field.user({ default: "currentUser" }),
    },
    tenant: "org",
    softDelete: true,
    search: true,
    defaultSort: "-occurredAt",
    views: { calendar: { kind: "calendar", dateField: "occurredAt" } },
    hooks: {
      beforeCreate: async (args) => void (await checkSubject(args, args.input, "activities")),
      beforeUpdate: async (args) => {
        if (args.changes.subjectType !== undefined || args.changes.subjectId !== undefined) {
          await checkSubject(args, { subjectType: args.changes.subjectType ?? args.before.subjectType, subjectId: args.changes.subjectId ?? args.before.subjectId }, "activities");
        }
      },
    },
  });
  const tasks = resource("tasks", {
    label: "Tasks",
    fields: {
      title: field.text({ required: true, max: 300, searchable: true }),
      status: field.select(["open", "in_progress", "done", "canceled"], { default: "open" }),
      priority: field.select(["low", "normal", "high"], { default: "normal" }),
      due: field.date({ index: true }),
      assignee: field.user({ default: "currentUser" }),
      subjectType: field.select(SUBJECTS, { label: "Linked to" }),
      subjectId: field.text({ index: true, label: "Linked record" }),
      notes: field.longText(),
      completedAt: field.datetime({ readOnly: true }),
    },
    tenant: "org",
    softDelete: true,
    search: true,
    views: {
      open: { filter: { status: { in: ["open", "in_progress"] } }, sort: "due" },
      board: { kind: "kanban", groupBy: "status" },
      calendar: { kind: "calendar", dateField: "due" },
    },
    hooks: {
      beforeCreate: async (args) => {
        await checkSubject(args, args.input, "tasks");
        return { ...args.input, completedAt: args.input.status === "done" ? new Date().toISOString() : null };
      },
      beforeUpdate: async (args) => {
        if (args.changes.subjectType !== undefined || args.changes.subjectId !== undefined) {
          await checkSubject(args, { subjectType: args.changes.subjectType ?? args.before.subjectType, subjectId: args.changes.subjectId ?? args.before.subjectId }, "tasks");
        }
        if (args.changes.status === undefined || args.changes.status === args.before.status) return args.changes;
        return { ...args.changes, completedAt: args.changes.status === "done" ? new Date().toISOString() : null };
      },
    },
  });
  return [companies, contacts, deals, activities, tasks];
}

const defaults = crmResources();
export const companies: Resource = defaults[0];
export const contacts: Resource = defaults[1];
export const deals: Resource = defaults[2];
export const activities: Resource = defaults[3];
export const tasks: Resource = defaults[4];

// ---------------------------------------------------------------------------------------------
// timeline

export interface TimelineEntry {
  kind: "activity" | "audit";
  /** ISO time. */
  at: string;
  id: string;
  actor: string | null;
  /** Activity subject, or the audit action ("create", "update", "delete", "action.markLost"). */
  title: string;
  /** kind "activity": the activity record. */
  activity?: AdminRecord;
  /** kind "audit": changed fields `{ field: { before?, after? } }`. */
  changes?: Record<string, unknown> | null;
}

export interface TimelineSource {
  /** Scoped data access (crm().data({ orgId }) or a hook/action's `data`). */
  data: DataAccess;
  /** Something with the audit query API: `ctx.audit` or an AuditStore. */
  audit?: { query(q: { resource?: string; resourceId?: string; org?: string; limit?: number }): Promise<{ items: AuditLike[] }> };
  orgId?: string | null;
  /** Default 50, max 200. */
  limit?: number;
}

interface AuditLike {
  seq: number;
  ts: number;
  action: string;
  actor: string | null;
  changes: Record<string, unknown> | null;
}

/** Activities linked to a record, merged with its audit trail, newest first. */
export async function timeline(ref: { resource: string; id: string }, src: TimelineSource): Promise<TimelineEntry[]> {
  const limit = Math.min(Math.max(src.limit ?? 50, 1), 200);
  const acts = await src.data("activities").list({ filter: { subjectType: ref.resource, subjectId: ref.id }, sort: "-occurredAt", limit });
  const out: TimelineEntry[] = acts.items.map((a) => ({
    kind: "activity",
    at: String(a.occurredAt ?? a.createdAt),
    id: a.id,
    actor: (a.owner as string | null) ?? null,
    title: String(a.subject),
    activity: a,
  }));
  if (src.audit) {
    const page = await src.audit.query({ resource: ref.resource, resourceId: ref.id, ...(src.orgId ? { org: src.orgId } : {}), limit });
    for (const e of page.items) {
      out.push({ kind: "audit", at: new Date(e.ts).toISOString(), id: `audit:${e.seq}`, actor: e.actor, title: e.action, changes: e.changes });
    }
  }
  // Newest first; for equal times audit rows keep their own (newest-first) order.
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.at.localeCompare(a.e.at) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

// ---------------------------------------------------------------------------------------------
// workflow actions and example workflows

export interface CrmNotification {
  orgId: string;
  userId: string | null;
  subject: string;
  text?: string;
  subjectType?: string;
  subjectId?: string;
}

/** New lead → follow-up task for its owner, due in 1 day. */
export const newLeadFollowUpSpec: WorkflowSpec = {
  name: "crm-new-lead-follow-up",
  description: "When a contact is created as a lead, create a follow-up task for its owner due tomorrow.",
  trigger: { type: "event", event: "contacts.created", match: { "data.record.stage": "lead" } },
  steps: [
    {
      id: "task",
      type: "action",
      action: "crm.create_task",
      params: {
        orgId: "{{ data.orgId }}",
        title: "Follow up with {{ data.record.name }}",
        assignee: "{{ data.record.owner }}",
        dueInDays: 1,
        subjectType: "contacts",
        subjectId: "{{ data.id }}",
      },
    },
  ],
};

/** Deal moved to won → notify its owner (once, when the stage changes). */
export const dealWonNotifyOwnerSpec: WorkflowSpec = {
  name: "crm-deal-won-notify-owner",
  description: "When a deal's stage changes to won, notify the deal owner.",
  trigger: { type: "event", event: "deals.updated", match: { "data.record.stage": "won" } },
  steps: [
    {
      id: "stage_changed",
      type: "condition",
      if: "'stage' in data.changes",
      then: [
        {
          id: "notify",
          type: "action",
          action: "crm.notify_owner",
          params: {
            orgId: "{{ data.orgId }}",
            userId: "{{ data.record.owner }}",
            subject: "Deal won: {{ data.record.title }}",
            text: "{{ data.record.title }} was marked won.",
            subjectType: "deals",
            subjectId: "{{ data.id }}",
          },
        },
      ],
    },
  ],
};

export interface CrmOptions extends Omit<AdminOptions, "resources">, CrmResourceOptions {
  /** More resources served next to the CRM ones (they may relate to them). */
  resources?: Resource[];
  /**
   * How `crm.notify_owner` reaches people. Default: a high-priority task assigned to the user
   * (visible in their task list); without a user it only logs.
   */
  notify?: (n: CrmNotification, ctx: ActionContext) => unknown | Promise<unknown>;
  /** Serve GET <basePath>/crm/timeline/:resource/:id. Default true. */
  timelineRoute?: boolean;
}

export type CrmKit = AdminPlugin & {
  /** Workflow actions: crm.create_task, crm.notify_owner. */
  actions: ActionDef[];
  /** The example workflows, ready for workflows({ workflows: [...kit.workflows] }). */
  workflows: WorkflowDef<Record<string, unknown>>[];
};

/**
 * The CRM kit as one admin plugin:
 *
 * ```ts
 * const kit = crm({ database: sqlite("crm.db") });
 * miu({ plugins: [auth(), access({ roles }), audit({ store }), workflows({ workflows: kit.workflows }), kit] });
 * ```
 */
export function crm(o: CrmOptions = {}): CrmKit {
  const { currency, resources: extra = [], notify, timelineRoute = true, ...adminOpts } = o;
  const resources = [...crmResources({ currency }), ...extra];
  const plugin = admin({ ...adminOpts, resources });
  const basePath = (o.basePath ?? "/api").replace(/\/$/, "");
  const byName = new Map(resources.map((r) => [r.name, r]));
  const dataFor = (orgId: string, env: Env) => plugin.data({ orgId, userId: null, env });

  const createTask = defineAction("crm.create_task", {
    description: "Create a CRM task in an organization (optionally linked to a record).",
    params: t.object({
      orgId: t.string({ minLength: 1 }),
      title: t.string({ minLength: 1, maxLength: 300 }),
      assignee: t.optional(t.nullable(t.string())),
      dueInDays: t.optional(t.integer({ min: 0, max: 3650 })),
      priority: t.optional(t.enum(["low", "normal", "high"])),
      subjectType: t.optional(t.nullable(t.string())),
      subjectId: t.optional(t.nullable(t.string())),
      notes: t.optional(t.string()),
    }),
    run: async (p, actx) => {
      const due = p.dueInDays === undefined ? undefined : new Date(Date.now() + p.dueInDays * 86_400_000).toISOString().slice(0, 10);
      const task = await dataFor(p.orgId, actx.env)("tasks").create({
        title: p.title,
        assignee: p.assignee ?? null,
        ...(due ? { due } : {}),
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.subjectType && p.subjectId ? { subjectType: p.subjectType, subjectId: p.subjectId } : {}),
        ...(p.notes ? { notes: p.notes } : {}),
      });
      return { taskId: task.id };
    },
  });
  const notifyOwner = defineAction("crm.notify_owner", {
    description: "Notify a user about a CRM record (default: a high-priority task assigned to them).",
    params: t.object({
      orgId: t.string({ minLength: 1 }),
      userId: t.optional(t.nullable(t.string())),
      subject: t.string({ minLength: 1, maxLength: 300 }),
      text: t.optional(t.string()),
      subjectType: t.optional(t.string()),
      subjectId: t.optional(t.string()),
    }),
    run: async (p, actx) => {
      const n: CrmNotification = { orgId: p.orgId, userId: p.userId ?? null, subject: p.subject, text: p.text, subjectType: p.subjectType, subjectId: p.subjectId };
      if (notify) return { notified: true, result: (await notify(n, actx)) ?? null };
      if (!n.userId) {
        actx.log.info("crm.notify_owner: no owner to notify", { subject: n.subject });
        return { notified: false };
      }
      const task = await dataFor(p.orgId, actx.env)("tasks").create({
        title: n.subject,
        assignee: n.userId,
        priority: "high",
        ...(n.text ? { notes: n.text } : {}),
        ...(n.subjectType && n.subjectId ? { subjectType: n.subjectType, subjectId: n.subjectId } : {}),
      });
      return { notified: true, taskId: task.id };
    },
  });
  const actions = [createTask, notifyOwner];
  const workflowDefs = [fromJson(newLeadFollowUpSpec, { actions }), fromJson(dealWonNotifyOwnerSpec, { actions })];

  const routes: RouteDef[] = [...plugin.routes];
  if (timelineRoute) {
    routes.push(
      route.get(`${basePath}/crm/timeline/:resource/:id`, {
        name: "crm_timeline",
        summary: "Timeline of a CRM record: its activities and change history, newest first",
        description: `resource is one of ${SUBJECTS.join(", ")}. Needs read access to the record and activities.`,
        tags: ["admin", "crm"],
        auth: "required",
        permission: activities.permissions!.read,
        params: t.object({ resource: t.string({ maxLength: 100 }), id: t.string({ minLength: 1, maxLength: 200 }) }),
        query: t.object({ limit: t.optional(t.integer({ min: 1, max: 200 })) }),
        handler: async (ctx) => {
          const c = ctx as unknown as Context;
          const target = SUBJECTS.includes(ctx.params.resource) ? byName.get(ctx.params.resource) : undefined;
          if (!target) throw errors.badRequest(`No timeline for "${ctx.params.resource}"`, `Use one of: ${SUBJECTS.join(", ")}.`);
          const scope = scopeFor(target, c);
          const runtime = await plugin.runtime(c);
          const repo = new Repo(runtime, target, scope);
          const rec = await repo.get(ctx.params.id);
          if (!rec) throw adminErrors.notFound(target.name, ctx.params.id);
          if (target.permissions) (c as { authorize?: (p: string, r?: unknown) => void }).authorize?.(target.permissions.read, rec);
          const audit = (c as { audit?: TimelineSource["audit"] }).audit;
          const items = await timeline({ resource: target.name, id: rec.id }, { data: repo.data(), audit, orgId: scope.orgId, limit: ctx.query.limit });
          // repo.data() reads as the system; row-level read policies on activities still apply.
          const can = (c as { can?: (p: string, r?: unknown) => boolean }).can;
          const visible = typeof can === "function" ? items.filter((e) => e.kind !== "activity" || can.call(c, activities.permissions!.read, e.activity)) : items;
          return { items: visible };
        },
      }),
    );
  }
  return Object.assign({}, plugin, { routes, actions, workflows: workflowDefs }) as CrmKit;
}
