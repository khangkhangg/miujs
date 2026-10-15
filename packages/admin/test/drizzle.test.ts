import { describe, expect, test } from "bun:test";
import { adminTables, field, resource } from "../src/index.ts";
import { resourceTables } from "../src/drizzle.ts";

const companies = resource("companies", { fields: { name: field.text({ required: true }) }, tenant: "org" });
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true }),
    email: field.email({ unique: true }),
    company: field.relation("companies", { onDelete: "set null" }),
    parent: field.relation("contacts"),
    vip: field.boolean(),
    value: field.money(),
    seen: field.datetime(),
    rating: field.number(),
    tags: field.tags(),
    data: field.json(),
    due: field.date({ index: true }),
  },
  tenant: "org",
  softDelete: true,
});

describe("resourceTables (via @miujs/db tableFromSchema)", () => {
  test("matches adminTables column for column", () => {
    const viaDrizzle = resourceTables([contacts, companies]);
    const plain = adminTables([contacts, companies]);
    for (const desc of plain) {
      const other = viaDrizzle[desc.name === "contacts" ? "contacts" : "companies"].description;
      const strip = (cs: typeof desc.columns) => cs.map(({ name, type, notNull, primaryKey }) => ({ name, type, notNull, primaryKey }));
      expect(strip(other.columns)).toEqual(strip(desc.columns));
      expect(other.foreignKeys).toEqual(desc.foreignKeys);
      expect(other.indexes.map((i) => [i.name, i.columns, i.unique, i.where ?? null])).toEqual(desc.indexes.map((i) => [i.name, i.columns, i.unique, i.where ?? null]));
    }
    expect(viaDrizzle.contacts.table).toBeTruthy();
    expect(viaDrizzle.contacts.description.name).toBe("contacts");
  });
});
