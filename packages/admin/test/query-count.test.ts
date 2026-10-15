// Bulk writes and imports must not issue a query per record for work that can be batched (N+1):
// relation checks, reading records back after the write, and uniqueness checks on import.

import { expect, test } from "bun:test";
import type { Database } from "@miujs/db";
import { field, resource } from "../src/index.ts";
import { setup, type Harness } from "./helpers.ts";

const companies = resource("companies", { fields: { name: field.text({ required: true }) }, tenant: "org" });
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true }),
    email: field.email({ unique: true }),
    company: field.relation("companies", { onDelete: "set null" }),
    stage: field.select(["lead", "customer"], { default: "lead" }),
  },
  tenant: "org",
  softDelete: true,
});

/** Statements against the resource tables while `fn` runs, grouped by kind. */
async function count(h: Harness, fn: () => Promise<unknown>): Promise<{ total: number; reads: number; writes: number }> {
  const db = h.db as Database & { prepare: Database["prepare"] };
  const prepare = db.prepare.bind(db);
  let reads = 0;
  let writes = 0;
  db.prepare = (sql: string) => {
    if (/"(contacts|companies)"/.test(sql)) {
      if (/^\s*SELECT/i.test(sql)) reads++;
      else writes++;
    }
    return prepare(sql);
  };
  try {
    await fn();
  } finally {
    db.prepare = prepare;
  }
  return { total: reads + writes, reads, writes };
}

test("bulk update of 200 records: relation checked once, records read back in chunks", async () => {
  const h = await setup([companies, contacts]);
  const co = (await h.req("POST", "/api/companies", { body: { name: "Acme" } })).body;
  const ids: string[] = [];
  const csv = ["name", ...Array.from({ length: 200 }, (_, i) => `P${i}`)].join("\n");
  ids.push(...(await h.req("POST", "/api/contacts/import", { body: { csv } })).body.ids);
  const c = await count(h, async () => {
    const r = await h.req("POST", "/api/contacts/bulk", { body: { action: "update", ids, changes: { company: co.id, stage: "customer" } } });
    expect(r.status).toBe(200);
  });
  // 200 UPDATEs are inherent; reads: the rows (3 chunks), one relation check, the read-back (3 chunks).
  expect(c.writes).toBe(200);
  expect(c.reads).toBeLessThanOrEqual(10);
  const after = (await h.req("GET", `/api/contacts?company=${co.id}&limit=200`)).body.items;
  expect(after.length).toBe(200);
});

test("import of 300 rows: uniqueness and relations checked in batches, not per row", async () => {
  const h = await setup([companies, contacts]);
  await h.req("POST", "/api/companies", { body: { name: "Acme" } });
  await h.req("POST", "/api/contacts", { body: { name: "Taken", email: "taken@x.io" } });
  const rows = Array.from({ length: 300 }, (_, i) => `P${i},p${i}@x.io,Acme`);
  const dry = await count(h, async () => {
    const r = await h.req("POST", "/api/contacts/import", { body: { csv: ["name,email,company", ...rows, "Dup,taken@x.io,"].join("\n"), dryRun: true } });
    expect(r.body.invalid).toBe(1);
    expect(r.body.errors[0]).toMatchObject({ row: 301, errors: [{ field: "email" }] });
  });
  expect(dry.reads).toBeLessThanOrEqual(20);
  const real = await count(h, async () => {
    const r = await h.req("POST", "/api/contacts/import", { body: { csv: ["name,email,company", ...rows].join("\n") } });
    expect(r.body.imported).toBe(300);
  });
  expect(real.writes).toBe(300);
  expect(real.reads).toBeLessThanOrEqual(30);
});
