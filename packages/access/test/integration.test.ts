import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { sqlite } from "@miujs/db";
import { access, defineRoles, tenantScope, type Mailer } from "../src/index.ts";
import { auth, memoryUserStore } from "../../auth/src/index.ts";
import { session } from "../../session/src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";

const BASE = "http://localhost";
const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };

describe("with real session + auth", () => {
  test("register → create org → invite by email → invitee registers and accepts → scoped access", async () => {
    const sent: { to: string; text: string }[] = [];
    const mailer: Mailer = { send: (m) => void sent.push(m) };
    const database = sqlite();
    const roles = defineRoles({ owner: ["*"], member: ["contacts:read", "members:read"] });
    const app = miu({
      logLevel: "silent",
      plugins: [session({ secret: SECRET }), auth({ users: memoryUserStore(), password: FAST, rateLimit: false }), access({ roles, database, mailer, appUrl: "https://app.test" })],
      routes: [route.get("/whoami", { auth: "required", handler: (c) => ({ org: tenantScope(c), role: c.org?.role, canInvite: c.can("members:invite") }) })],
    });
    const json = (jar: Jar, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.fetch(jar.request(`${BASE}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));

    const owner = new Jar();
    owner.store(await json(owner, "POST", "/auth/register", { email: "owner@example.com", password: "correct horse battery" }));
    const created = await json(owner, "POST", "/orgs", { name: "Clinic" });
    expect(created.status).toBe(201);
    const orgId = (await created.json()).org.id;
    expect((await json(owner, "POST", `/orgs/${orgId}/invites`, { email: "Nurse@Example.com", role: "member" })).status).toBe(201);
    const token = sent[0].text.match(/invites\/([A-Za-z0-9_-]+)/)![1];

    // Someone else signed in cannot use the link.
    const intruder = new Jar();
    intruder.store(await json(intruder, "POST", "/auth/register", { email: "intruder@example.com", password: "correct horse battery" }));
    expect((await json(intruder, "POST", `/invites/${token}/accept`)).status).toBe(403);
    expect((await json(intruder, "GET", "/whoami", undefined, { "x-org-id": orgId })).status).toBe(403);

    const nurse = new Jar();
    nurse.store(await json(nurse, "POST", "/auth/register", { email: "nurse@example.com", password: "correct horse battery" }));
    const accepted = await json(nurse, "POST", `/invites/${token}/accept`);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).org).toEqual({ id: orgId, name: "Clinic", role: "member" });

    const who = await json(nurse, "GET", "/whoami", undefined, { "x-org-id": orgId });
    expect(await who.json()).toEqual({ org: orgId, role: "member", canInvite: false });
    const members = await (await json(nurse, "GET", `/orgs/${orgId}/members`)).json();
    expect(members.members.map((m: any) => [m.email, m.role])).toEqual([
      ["owner@example.com", "owner"],
      ["nurse@example.com", "member"],
    ]);
  });
});
