// Sample data for the CRM example: three users (owner, admin, sales), one organization and a
// few companies, contacts, deals, activities and tasks.
//
//   bun examples/crm/seed.ts                 # writes crm.db (or $DB_PATH)
//   SEED_PASSWORD="..." bun examples/crm/seed.ts

import { processEnv } from "miujs";
import { accessStore } from "@miujs/access";
import type { AdminService } from "@miujs/admin";
import type { Database } from "@miujs/db";
import { createApp } from "./app.ts";

type App = ReturnType<typeof createApp>["app"];

export interface SeedOptions {
  password: string;
  orgName?: string;
}

const USERS = [
  { email: "owner@example.com", name: "Olivia Owner", role: "owner" },
  { email: "admin@example.com", name: "Adam Admin", role: "admin" },
  { email: "sales@example.com", name: "Sam Sales", role: "sales" },
] as const;

export async function seed(app: App, database: Database | null, o: SeedOptions) {
  if (!database) throw new Error("Seed a local SQLite database (DB_PATH), then upload it to D1 with wrangler d1 import.");
  await app.ready();
  const users: { id: string; email: string; role: string }[] = [];
  for (const u of USERS) {
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: u.email, password: o.password, name: u.name }),
    });
    const body = (await res.json()) as { user?: { id: string }; error?: { message: string } };
    if (!body.user) throw new Error(`Could not create ${u.email}: ${body.error?.message ?? res.status}`);
    users.push({ id: body.user.id, email: u.email, role: u.role });
  }
  const orgs = accessStore(database);
  const [owner, ...rest] = users;
  const org = await orgs.createOrg({ name: o.orgName ?? "Acme Inc", ownerId: owner.id, ownerEmail: owner.email });
  for (const u of rest) await orgs.addMember(org.id, u.id, u.role, u.email);

  const sales = users[2];
  const data = app.service<AdminService>("admin").data({ orgId: org.id, userId: owner.id });
  const globex = await data("companies").create({ name: "Globex", domain: "globex.example", industry: "manufacturing", size: "201-1000", owner: sales.id });
  const initech = await data("companies").create({ name: "Initech", domain: "initech.example", industry: "software", size: "51-200", owner: owner.id });
  const hank = await data("contacts").create({ name: "Hank Scorpio", email: "hank@globex.example", company: globex.id, stage: "qualified", value: 2_500_000, tags: ["vip"], owner: sales.id });
  const peter = await data("contacts").create({ name: "Peter Gibbons", email: "peter@initech.example", company: initech.id, stage: "lead", owner: sales.id, nextFollowUp: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) });
  await data("contacts").create({ name: "Joanna", email: "joanna@chotchkies.example", stage: "customer", value: 120_000, owner: owner.id });
  await data("deals").create({ title: "Platform rollout", company: globex.id, contact: hank.id, stage: "proposal", amount: 4_800_000, expectedClose: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), owner: sales.id });
  await data("deals").create({ title: "TPS report automation", company: initech.id, contact: peter.id, stage: "lead", amount: 650_000, owner: sales.id });
  await data("deals").create({ title: "Stapler supply", company: initech.id, stage: "won", amount: 9_900, owner: owner.id });
  await data("activities").create({ type: "call", subject: "Intro call with Hank", body: "<p>Wants a <strong>pilot</strong> in Q3.</p>", subjectType: "contacts", subjectId: hank.id, durationMinutes: 30, owner: sales.id });
  await data("activities").create({ type: "meeting", subject: "Demo for Initech", subjectType: "companies", subjectId: initech.id, owner: sales.id });
  await data("tasks").create({ title: "Send the pilot proposal", priority: "high", due: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), assignee: sales.id, subjectType: "contacts", subjectId: hank.id });
  return { org, users };
}

if (import.meta.main) {
  const env = processEnv();
  const password = env.SEED_PASSWORD ?? "correct horse battery";
  const { app, database } = createApp({ dbPath: env.DB_PATH ?? "crm.db", dev: true });
  const out = await seed(app, database, { password });
  console.log(`Seeded organization "${out.org.name}". Sign in at /admin with:`);
  for (const u of out.users) console.log(`  ${u.role.padEnd(5)}  ${u.email}  /  ${password}`);
  process.exit(0);
}
