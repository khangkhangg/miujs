import { definePlugin, miu, type AuthUser, type Plugin } from "miujs";
import { db as dbPlugin, sqlite, type Database } from "@miujs/db";
import { access, accessStore, defineRoles } from "@miujs/access";
import { audit, memoryAuditStore } from "@miujs/audit";
import { workflows, type WorkflowDef } from "@miujs/workflows";
import { admin, type AdminPlugin, type Resource } from "../../src/index.ts";
import { adminUI, type AdminUIOptions } from "../../src/ui/index.ts";
import { testClock } from "../helpers.ts";

export { XSS } from "./fixtures.ts";

/** Test-only sign-in: `x-user: <id>` picks a user (stands in for @miujs/auth). */
function testAuth(ids: string[]) {
  return definePlugin({
    name: "test-auth",
    onRequest(ctx) {
      const id = ctx.headers.get("x-user");
      if (id && ids.includes(id)) ctx.user = { id, roles: [], email: `${id}@example.com` } as AuthUser;
    },
  });
}

export const UI_ROLES = defineRoles({
  owner: ["*"],
  member: ["contacts:*", "companies:read", "companies:create", "activities:*", "deals:*", "tasks:*"],
  viewer: ["contacts:read", "companies:read"],
  narrow: ["contacts:read"],
  wfread: ["workflows:read", "contacts:read"],
});

export interface UiHarness {
  app: ReturnType<typeof miu>;
  db: Database;
  wf: ReturnType<typeof workflows>;
  orgA: string;
  orgB: string;
  clock: ReturnType<typeof testClock>;
  /** Raw request. `user` (default ann) via x-user; `org` via x-org-id unless null. */
  req(method: string, path: string, o?: { user?: string | null; org?: string | null; body?: unknown; form?: Record<string, string | string[]>; headers?: Record<string, string>; raw?: BodyInit }): Promise<{ status: number; text: string; body: any; headers: Headers }>;
  settle(): Promise<void>;
}

/**
 * ann: owner of A and member of B · bob: member of A · vic: viewer of A · nora: narrow (contacts:read) of A
 * · wren: wfread of A · eve: owner of B · zed: no org.
 */
export async function uiSetup(resources: Resource[], o: { ui?: AdminUIOptions; plugins?: Plugin[]; workflows?: WorkflowDef<any>[]; adminPlugin?: (db: Database) => AdminPlugin; before?: Plugin[] } = {}): Promise<UiHarness> {
  const database = sqlite();
  const clock = testClock();
  const wf = workflows({ workflows: o.workflows ?? [], clock });
  const adminPlugin = o.adminPlugin ? o.adminPlugin(database) : admin({ resources, database });
  const app = miu({
    logLevel: "silent",
    plugins: [
      ...(o.before ?? []),
      dbPlugin({ database }),
      testAuth(["ann", "bob", "vic", "nora", "wren", "eve", "zed"]),
      access({ roles: UI_ROLES, database }),
      audit({ store: memoryAuditStore(), routes: false }),
      wf,
      adminPlugin,
      adminUI(o.ui ?? { title: "Test Admin" }),
      ...(o.plugins ?? []),
    ],
  });
  const store = accessStore(database);
  const orgA = (await store.createOrg({ name: "Org A", ownerId: "ann" })).id;
  const orgB = (await store.createOrg({ name: "Org <B>", ownerId: "eve" })).id;
  await store.addMember(orgA, "bob", "member");
  await store.addMember(orgA, "vic", "viewer");
  await store.addMember(orgA, "nora", "narrow");
  await store.addMember(orgA, "wren", "wfread");
  await store.addMember(orgB, "ann", "member");
  await app.ready();

  const req: UiHarness["req"] = async (method, path, r = {}) => {
    const headers = new Headers(r.headers);
    const user = r.user === undefined ? "ann" : r.user;
    if (user) headers.set("x-user", user);
    const org = r.org === undefined ? (user === "eve" ? orgB : orgA) : r.org;
    if (org) headers.set("x-org-id", org);
    if (!headers.has("origin")) headers.set("origin", "http://localhost");
    let body: BodyInit | undefined = r.raw;
    if (r.body !== undefined) {
      body = JSON.stringify(r.body);
      headers.set("content-type", "application/json");
    } else if (r.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(r.form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      body = p.toString();
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const res = await app.request(path, { method, headers, body, redirect: "manual" });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {}
    return { status: res.status, text, body: parsed, headers: res.headers };
  };
  const settle = async () => {
    await app.drain();
    for (let i = 0; i < 5; i++) {
      await wf.drain();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { app, db: database, wf, orgA, orgB, clock, req, settle };
}

/** Fails when attacker-controlled markup made it into the page unescaped. */
export function expectNoXss(html: string): void {
  const fail = (what: string, at: number) => {
    throw new Error(`Unescaped markup (${what}) near: ${html.slice(Math.max(0, at - 80), at + 80)}`);
  };
  for (const re of [/<script>alert/i, /<img src=x/i]) {
    const m = re.exec(html);
    if (m) fail(m[0], m.index);
  }
  // Real tags only (escaped text starts with &lt;); quoted values removed before looking for on*=.
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const bare = m[0].replace(/"[^"]*"/g, '""');
    if (/\son[a-z]+\s*=/i.test(bare)) fail("event handler attribute", m.index!);
    if (/\b(href|src|action|formaction)="\s*javascript:/i.test(m[0])) fail("javascript: URL", m.index!);
  }
}
