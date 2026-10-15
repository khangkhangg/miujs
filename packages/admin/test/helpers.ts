import { definePlugin, miu, type AuthUser, type Plugin } from "miujs";
import { db as dbPlugin, sqlite, type Database } from "@miujs/db";
import { access, accessStore, defineRoles, type Policy } from "@miujs/access";
import { audit, memoryAuditStore, type AuditStore } from "@miujs/audit";
import { defineWorkflow, on, workflows, type WorkflowDef } from "@miujs/workflows";
import { admin, type AdminOptions, type AdminPlugin, type Resource } from "../src/index.ts";

/** Test-only sign-in: `x-user: <id>` picks a user. Stands in for @miujs/auth (as in @miujs/access tests). */
export function testAuth(users: Record<string, { roles: string[]; email?: string }>) {
  return definePlugin({
    name: "test-auth",
    onRequest(ctx) {
      const id = ctx.headers.get("x-user");
      if (id && Object.prototype.hasOwnProperty.call(users, id)) ctx.user = { id, ...users[id] } as AuthUser;
    },
  });
}

/** A fake clock (time only moves when told), so workflow sleeps finish instantly in drain(). */
export function testClock(start = Date.UTC(2026, 2, 2, 9, 0, 0)) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const advanceTo = (time: number) => {
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of timers) if (e[1].at <= time && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
    }
    now = Math.max(now, time);
  };
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h: unknown) {
      timers.delete(h as number);
    },
    advanceTo,
    advance: (ms: number) => advanceTo(now + ms),
  };
}

export const ROLES = defineRoles({
  owner: ["*"],
  member: ["contacts:read", "contacts:create", "contacts:update", "contacts:delete", "companies:read", "companies:create", "companies:update", "deals:*", "activities:*", "tasks:*"],
  viewer: ["contacts:read", "companies:read"],
  exporter: ["contacts:read", "contacts:export", "companies:read"],
  noCompanies: ["contacts:read"],
  editor: ["contacts:read", "contacts:update", "companies:read"],
});

export interface SetupOptions {
  admin?: Partial<AdminOptions>;
  policies?: Policy[];
  workflows?: WorkflowDef<any>[];
  /** Event names the recorder workflow listens to. */
  record?: string[];
  plugins?: Plugin[];
  mcp?: boolean;
  /** Use this admin plugin (e.g. crm()) instead of admin({ resources }). It gets ctx.db from db(). */
  crm?: AdminPlugin;
}

export interface Harness {
  app: ReturnType<typeof miu>;
  db: Database;
  auditStore: AuditStore;
  wf: ReturnType<typeof workflows>;
  clock: ReturnType<typeof testClock>;
  events: { event: string; data: any }[];
  orgA: string;
  orgB: string;
  adminPlugin: AdminPlugin;
  req(method: string, path: string, o?: { user?: string | null; org?: string | null; body?: unknown; headers?: Record<string, string>; raw?: BodyInit }): Promise<{ status: number; body: any; text: string; headers: Headers }>;
  settle(): Promise<void>;
}

/**
 * Users: ann (owner of A), bob (member of A), vic (viewer of A), eve (owner of B), exp (exporter of A),
 * nora (A, no companies:read), zed (no org).
 */
export async function setup(resources: Resource[], o: SetupOptions = {}): Promise<Harness> {
  const db = sqlite();
  const auditStore = memoryAuditStore();
  const clock = testClock();
  const events: { event: string; data: any }[] = [];
  const recorder = defineWorkflow("recorder", {
    trigger: (o.record ?? resources.flatMap((r) => [`${r.name}.created`, `${r.name}.updated`, `${r.name}.deleted`])).map((e) => on(e)),
    run: ({ input, run }) => {
      events.push({ event: (run.trigger as { event?: string }).event ?? "", data: input });
    },
  });
  const wf = workflows({ workflows: [recorder, ...(o.workflows ?? [])], clock });
  const adminPlugin = o.crm ?? admin({ resources, database: db, ...o.admin });
  const app = miu({
    logLevel: "silent",
    mcp: o.mcp ?? false,
    plugins: [
      dbPlugin({ database: db }),
      testAuth({
        ann: { roles: [] },
        bob: { roles: [] },
        vic: { roles: [] },
        eve: { roles: [] },
        exp: { roles: [] },
        nora: { roles: [] },
        zed: { roles: [] },
        root: { roles: ["owner"] },
        ed: { roles: [] },
      }),
      access({ roles: ROLES, policies: o.policies, database: db, routes: false }),
      audit({ store: auditStore, routes: false }),
      wf,
      ...(o.plugins ?? []),
      adminPlugin,
    ],
  });
  const store = accessStore(db);
  const orgA = (await store.createOrg({ name: "A", ownerId: "ann" })).id;
  const orgB = (await store.createOrg({ name: "B", ownerId: "eve" })).id;
  await store.addMember(orgA, "bob", "member");
  await store.addMember(orgA, "vic", "viewer");
  await store.addMember(orgA, "exp", "exporter");
  await store.addMember(orgA, "nora", "noCompanies");
  await store.addMember(orgA, "ed", "editor");
  await app.ready();

  const req: Harness["req"] = async (method, path, r = {}) => {
    const headers = new Headers(r.headers);
    const user = r.user === undefined ? "ann" : r.user;
    if (user) headers.set("x-user", user);
    const org = r.org === undefined ? (user === "eve" ? orgB : orgA) : r.org;
    if (org) headers.set("x-org-id", org);
    let body: BodyInit | undefined = r.raw;
    if (r.body !== undefined) {
      body = JSON.stringify(r.body);
      headers.set("content-type", "application/json");
    }
    const res = await app.request(path, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {}
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  const settle = async () => {
    await app.drain();
    for (let i = 0; i < 5; i++) {
      await wf.drain();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { app, db, auditStore, wf, clock, events, orgA, orgB, adminPlugin, req, settle };
}
