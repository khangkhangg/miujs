// Contacts are tenant data: every query filters by tenantScope(ctx), the org id the access plugin
// verified. Creating a contact emits `contact.created` for the follow-up workflow.

import { errors, route, t, type CallFn } from "miujs";
import { tenantScope } from "@miujs/access";

export const STAGES = ["lead", "qualified", "customer", "lost"] as const;

const Contact = t.object({
  id: t.string(),
  name: t.string(),
  email: t.nullable(t.string()),
  stage: t.enum(STAGES),
  createdAt: t.string(),
});

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  stage: (typeof STAGES)[number];
  created_at: string;
}
const toContact = (r: ContactRow) => ({ id: r.id, name: r.name, email: r.email, stage: r.stage, createdAt: r.created_at });

export const listContacts = route.get("/contacts", {
  summary: "List the active organization's contacts, newest first",
  auth: "required",
  query: t.object({ stage: t.optional(t.enum(STAGES)) }),
  response: t.object({ contacts: t.array(Contact) }),
  handler: async (ctx) => {
    ctx.authorize("contacts:read");
    const orgId = tenantScope(ctx);
    const stmt = ctx.query.stage
      ? ctx.db.prepare("SELECT * FROM contacts WHERE org_id = ? AND stage = ? ORDER BY created_at DESC").bind(orgId, ctx.query.stage)
      : ctx.db.prepare("SELECT * FROM contacts WHERE org_id = ? ORDER BY created_at DESC").bind(orgId);
    const { results } = await stmt.all<ContactRow>();
    return { contacts: results.map(toContact) };
  },
});

export const createContact = route.post("/contacts", {
  summary: "Add a contact to the active organization",
  auth: "required",
  body: t.object({ name: t.string({ minLength: 1, maxLength: 200 }), email: t.optional(t.string({ maxLength: 320 })) }),
  response: Contact,
  handler: async (ctx) => {
    ctx.authorize("contacts:write");
    const orgId = tenantScope(ctx);
    const contact = { id: crypto.randomUUID(), name: ctx.body.name, email: ctx.body.email ?? null, stage: "lead" as const, createdAt: new Date().toISOString() };
    await ctx.db
      .prepare("INSERT INTO contacts (id, org_id, name, email, stage, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(contact.id, orgId, contact.name, contact.email, contact.stage, contact.createdAt)
      .run();
    await ctx.events.emit("contact.created", { contactId: contact.id, orgId, name: contact.name });
    ctx.set.status = 201;
    return contact;
  },
});

export const setStage = route.patch("/contacts/:id/stage", {
  summary: "Move a contact to another pipeline stage",
  auth: "required",
  params: t.object({ id: t.string() }),
  body: t.object({ stage: t.enum(STAGES) }),
  response: Contact,
  handler: async (ctx) => {
    ctx.authorize("contacts:write");
    const orgId = tenantScope(ctx);
    await ctx.db.prepare("UPDATE contacts SET stage = ? WHERE org_id = ? AND id = ?").bind(ctx.body.stage, orgId, ctx.params.id).run();
    const row = await ctx.db.prepare("SELECT * FROM contacts WHERE org_id = ? AND id = ?").bind(orgId, ctx.params.id).first<ContactRow>();
    if (!row) throw errors.notFound("contact", ctx.params.id);
    return toContact(row);
  },
});

export const tests = {
  "listing contacts needs a signed-in user": async (call: CallFn) => {
    (await call(listContacts)).expectStatus(401);
  },
  "adding a contact needs a signed-in user": async (call: CallFn) => {
    (await call(createContact, { body: { name: "Ada" } })).expectStatus(401);
  },
};
