import { field, resource, type Resource } from "../../src/index.ts";

export const XSS = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;

/** Every field type, a kanban + calendar + table view, actions, and XSS in labels/options. */
export function uiResources(): Resource[] {
  const companies = resource("companies", {
    label: "Companies",
    fields: { name: field.text({ required: true, searchable: true }), domain: field.text() },
    tenant: "org",
    search: true,
  });
  const contacts = resource("contacts", {
    label: "Contacts",
    fields: {
      name: field.text({ required: true, max: 200, searchable: true }),
      bio: field.longText({ label: `Bio ${XSS}` }),
      notes: field.richText(),
      email: field.email({ unique: true }),
      phone: field.phone(),
      site: field.url(),
      score: field.number({ integer: true, min: 0, max: 100 }),
      value: field.money({ currency: "USD" }),
      chance: field.percent(),
      vip: field.boolean(),
      birthday: field.date(),
      lastSeen: field.datetime(),
      stage: field.select([{ value: "lead", color: "blue" }, "customer", { value: "lost", label: `Lost ${XSS}`, color: "red;background:url(x)" }], { default: "lead" }),
      channels: field.multiSelect(["email", "phone"]),
      tags: field.tags(),
      company: field.relation("companies", { onDelete: "set null" }),
      owner: field.user({ default: "currentUser" }),
      avatar: field.file(),
      meta: field.json(),
      secret: field.text({ readOnly: true }),
    },
    tenant: "org",
    search: true,
    views: {
      pipeline: { kind: "kanban", groupBy: "stage" },
      birthdays: { label: "Birthdays", kind: "calendar", dateField: "birthday" },
      leads: { label: `Leads ${XSS}`, filter: { stage: "lead" }, sort: "name" },
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
      ping: { label: "Ping", run: async () => ({ ok: true }) },
    },
  });
  return [companies, contacts];
}
