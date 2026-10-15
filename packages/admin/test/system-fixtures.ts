// Fake plugins with manage() sections and an app harness for the System area tests.

import { definePlugin, errors, miu, t, type AuthUser, type ManageSection, type Plugin } from "miujs";
import { db as dbPlugin, sqlite, type Database } from "@miujs/db";
import { access, accessStore, defineRoles } from "@miujs/access";
import { audit, memoryAuditStore, type AuditStore } from "@miujs/audit";
import { admin, type AdminOptions } from "../src/index.ts";
import { adminUI } from "../src/ui/index.ts";

export const XSS = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;

export interface JobsState {
  settings: { concurrency: number; paused: boolean; apiToken?: string };
  sets: { concurrency: number; paused: boolean; apiToken?: string }[];
  runs: { action: string; input: unknown }[];
  queries: { cursor?: string; limit: number; search?: string; filters?: Record<string, string> }[];
}

const JOBS = Array.from({ length: 7 }, (_, i) => ({ id: `job${i}`, name: i === 3 ? XSS : `Job ${i}`, state: i % 2 ? "failed" : "done", bytes: 1024 * i, at: Date.UTC(2026, 0, 1) }));

/** A queue-like plugin: status, a paged list with row actions, settings and actions (one danger). */
export function jobsPlugin(name = "jobs") {
  const state: JobsState = { settings: { concurrency: 4, paused: false, apiToken: "secret-token" }, sets: [], runs: [], queries: [] };
  const sections = (): ManageSection[] => [
    {
      id: "queue",
      title: "Queue",
      description: `Background jobs ${XSS}`,
      status: () => ({
        stats: [
          { label: "Pending", value: 3, tone: "warning", hint: "waiting to run" },
          { label: `Label ${XSS}`, value: XSS },
        ],
        tables: [{ title: "Workers", columns: [{ key: "id", label: "Id" }, { key: "mem", label: "Memory", type: "bytes" }], rows: [{ id: `w1${XSS}`, mem: 2048 }] }],
      }),
      lists: [
        {
          name: "jobs",
          title: "Jobs",
          idKey: "id",
          searchable: true,
          columns: [
            { key: "id", label: "Id", type: "code" },
            { key: "name", label: "Name" },
            { key: "state", label: "State" },
            { key: "bytes", label: "Size", type: "bytes" },
          ],
          filters: [{ key: "state", label: "State", options: ["failed", "done"] }],
          list: (q) => {
            state.queries.push(q);
            let rows = JOBS.filter((j) => (!q.search || j.name.includes(q.search)) && (!q.filters?.state || j.state === q.filters.state));
            const start = q.cursor ? Number(q.cursor) : 0;
            const page = rows.slice(start, start + q.limit);
            rows = page;
            return { rows, next: start + q.limit < JOBS.length ? String(start + q.limit) : undefined };
          },
          rowActions: [
            {
              name: "retry",
              title: "Retry",
              run: (input) => {
                state.runs.push({ action: "retry", input });
                return { retried: (input as { id: string }).id };
              },
            },
            {
              name: "remove",
              title: "Remove",
              danger: true,
              input: t.object({ reason: t.string({ minLength: 1 }) }),
              run: (input) => {
                state.runs.push({ action: "remove", input });
                return "removed";
              },
            },
          ],
        },
      ],
      settings: {
        schema: t.object({ concurrency: t.integer({ min: 1, max: 50 }), paused: t.boolean(), apiToken: t.optional(t.string()) }),
        get: () => ({ ...state.settings }),
        set: (v) => {
          state.settings = { ...v };
          state.sets.push({ ...v });
        },
      },
      actions: [
        {
          name: "purge",
          title: "Purge old jobs",
          description: "Deletes finished jobs older than N days",
          danger: true,
          input: t.object({ olderThanDays: t.integer({ min: 1 }), password: t.optional(t.string()) }),
          run: (input) => {
            state.runs.push({ action: "purge", input });
            return { purged: 2 };
          },
        },
        {
          name: "ping",
          title: "Ping",
          run: (input) => {
            state.runs.push({ action: "ping", input });
            return "pong";
          },
        },
        {
          name: "boom",
          title: "Explode",
          run: () => {
            throw errors.custom({ code: "MIU_E_TEST_BOOM", status: 409, message: "It broke", fix: "Do not press it." });
          },
        },
        { name: "html", title: `Html ${XSS}`, run: () => XSS },
      ],
    },
  ];
  const plugin = definePlugin({ name, manage: sections, inspect: () => ({ backend: "memory", secret: "hidden-value" }), cloudflare: () => ({ kv: ["JOBS"] }) });
  return { plugin, state };
}

/** A second plugin: status only, plus one action. */
export function mailerPlugin() {
  let flushed = 0;
  const plugin = definePlugin({
    name: "mailer",
    manage: (): ManageSection[] => [
      {
        id: "outbox",
        title: "Outbox",
        status: () => ({ stats: [{ label: "Queued", value: 5 }] }),
        actions: [{ name: "flush", title: "Flush", run: () => ({ flushed: ++flushed }) }],
      },
    ],
  });
  return { plugin, flushed: () => flushed };
}

/** Bearer `<user id>` signs in (MCP forwards `authorization`), with the given global roles. */
export function bearerAuth(users: Record<string, string[]>) {
  return definePlugin({
    name: "test-auth",
    onRequest(ctx) {
      const id = (ctx.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (id && Object.prototype.hasOwnProperty.call(users, id)) ctx.user = { id, roles: users[id] } as AuthUser;
    },
  });
}

export function fakeClock(start = Date.UTC(2026, 4, 1)) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

export const SYSTEM_ROLES = defineRoles({
  owner: ["*"],
  operator: ["system:*"],
  viewer: ["system:read"],
  jobsOps: ["system.jobs:read", "system.jobs:ping"],
  member: ["contacts:read"],
});

export interface SystemHarness {
  app: ReturnType<typeof miu>;
  db: Database;
  auditStore: AuditStore;
  jobs: JobsState;
  clock: ReturnType<typeof fakeClock>;
  orgA: string | null;
  req(method: string, path: string, o?: { user?: string | null; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> }): Promise<{ status: number; body: any; text: string; headers: Headers }>;
  mcp(method: string, params?: unknown, user?: string): Promise<any>;
}

/**
 * Users without access: root (role admin), bob (no roles). With access: op (operator), view
 * (viewer), jo (jobsOps), ann (no global role, owner of org A).
 */
export async function systemSetup(o: { access?: boolean; admin?: Partial<AdminOptions>; database?: Database; plugins?: Plugin[]; clock?: ReturnType<typeof fakeClock>; audit?: boolean; ui?: boolean } = {}): Promise<SystemHarness> {
  const database = o.database ?? sqlite();
  const auditStore = memoryAuditStore();
  const clock = o.clock ?? fakeClock();
  const jobs = jobsPlugin();
  const users = { root: ["admin"], bob: [], op: ["operator"], view: ["viewer"], jo: ["jobsOps"], ann: [] };
  const app = miu({
    logLevel: "silent",
    mcp: true,
    plugins: [
      dbPlugin({ database }),
      bearerAuth(users),
      ...(o.access ? [access({ roles: SYSTEM_ROLES, database, routes: false })] : []),
      ...(o.audit === false ? [] : [audit({ store: auditStore, routes: false })]),
      jobs.plugin,
      mailerPlugin().plugin,
      ...(o.plugins ?? []),
      admin({ resources: [], database, autoMigrate: true, now: clock.now, ...o.admin }),
      ...(o.ui ? [adminUI({ title: "Ops", workflows: false })] : []),
    ],
  });
  let orgA: string | null = null;
  if (o.access) orgA = (await accessStore(database).createOrg({ name: "A", ownerId: "ann" })).id;
  await app.ready();
  const req: SystemHarness["req"] = async (method, path, r = {}) => {
    const headers = new Headers(r.headers);
    const user = r.user === undefined ? "root" : r.user;
    if (user) headers.set("authorization", `Bearer ${user}`);
    if (!headers.has("origin")) headers.set("origin", "http://localhost");
    let body: string | undefined;
    if (r.body !== undefined) {
      body = JSON.stringify(r.body);
      headers.set("content-type", "application/json");
    } else if (r.form) {
      body = new URLSearchParams(r.form).toString();
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const res = await app.request(path, { method, headers, body, redirect: "manual" });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {}
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  const mcp: SystemHarness["mcp"] = async (method, params, user = "root") => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${user}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    });
    return res.json();
  };
  return { app, db: database, auditStore, jobs: jobs.state, clock, orgA, req, mcp };
}
