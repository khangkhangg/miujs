// access().manage(): roles, orgs and memberships for operators.
import { describe, expect, test } from "bun:test";
import { miu, route, validate, type Context, type ManageAction, type ManageList } from "miujs";
import { sqlite } from "@miujs/db";
import { access, accessStore, defineRoles, policy } from "../src/index.ts";
import { USERS, testAuth } from "./helpers.ts";

const roles = defineRoles({
  owner: ["*"],
  admin: ["contacts:*", "members:*"],
  member: ["contacts:read", "contacts:create"],
});

async function setup() {
  const database = sqlite();
  const store = accessStore(database);
  const A = await store.createOrg({ name: "Acme", ownerId: "alice", ownerEmail: "alice@example.com", id: "org-a" });
  const B = await store.createOrg({ name: "Beta", ownerId: "bob", ownerEmail: "bob@example.com", id: "org-b" });
  await store.addMember(A.id, "carol", "member", "carol@example.com");
  await store.addMember(A.id, "dave", "admin", "dave@example.com");
  await store.addMember(B.id, "carol", "member", "carol@example.com");
  await store.createInvite({ id: "i1", orgId: A.id, email: "eve@example.com", role: "member", tokenHash: "secret-token-hash-1", invitedBy: "alice", createdAt: 1, expiresAt: Date.now() + 86_400_000, acceptedAt: null, acceptedBy: null });
  await store.createInvite({ id: "i2", orgId: A.id, email: "fay@example.com", role: "member", tokenHash: "secret-token-hash-2", invitedBy: "alice", createdAt: 1, expiresAt: Date.now() + 86_400_000, acceptedAt: null, acceptedBy: null });
  await store.consumeInvite("i2", "fay", Date.now());
  await store.createInvite({ id: "i3", orgId: A.id, email: "gus@example.com", role: "member", tokenHash: "secret-token-hash-3", invitedBy: "alice", createdAt: 1, expiresAt: 1, acceptedAt: null, acceptedBy: null });
  const plugin = access({ roles, policies: [policy("contacts", { update: () => true })], database });
  let grabbed: Context | undefined;
  const app = miu({ logLevel: "silent", plugins: [testAuth(USERS), plugin], routes: [route.get("/__ctx", { handler: (c) => void (grabbed = c as unknown as Context) })] });
  await app.fetch(new Request("http://localhost/__ctx"));
  const sections = plugin.manage!();
  const section = sections.find((s) => s.id === "access")!;
  return { app, database, store, A, B, ctx: grabbed!, sections, section };
}
type S = Awaited<ReturnType<typeof setup>>;

const list = (s: S, name: string) => s.section.lists!.find((l) => l.name === name)!;
const rowAction = (l: ManageList, name: string) => l.rowActions!.find((a) => a.name === name)!;
async function run(s: S, a: ManageAction | undefined, input: Record<string, unknown>) {
  expect(a).toBeDefined();
  const v = validate(a!.input!, input);
  if (!v.ok) throw new Error(`invalid input: ${JSON.stringify(v.issues)}`);
  return a!.run(v.value, s.ctx);
}
const memberId = (orgId: string, userId: string) => `${encodeURIComponent(orgId)}/${encodeURIComponent(userId)}`;

describe("access manage()", () => {
  test("one 'access' section; names are well-formed", async () => {
    const s = await setup();
    expect(s.sections.map((x) => x.id)).toEqual(["access"]);
    for (const l of s.section.lists!) for (const a of [l, ...(l.rowActions ?? [])]) expect(a.name).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
    for (const a of s.section.actions!) expect(a.name).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
  });

  test("status: role table with permission counts, and org/member/invite counts; no invite token hashes", async () => {
    const s = await setup();
    const st = await s.section.status!(s.ctx);
    const v = (label: string) => st.stats!.find((x) => x.label === label)?.value;
    expect(v("Roles")).toBe(3);
    expect(v("Organizations")).toBe(2);
    expect(v("Memberships")).toBe(5);
    expect(v("Pending invites")).toBe(1);
    expect(v("Policies")).toBe(1);
    const table = st.tables!.find((x) => x.title === "Roles")!;
    expect(table.rows).toEqual([
      { role: "owner", permissions: 1, grants: "*", owner: true },
      { role: "admin", permissions: 2, grants: "contacts:*, members:*", owner: false },
      { role: "member", permissions: 2, grants: "contacts:read, contacts:create", owner: false },
    ]);
    expect(JSON.stringify(st)).not.toContain("secret-token-hash");
  });

  test("orgs list pages and searches by name; shows member counts", async () => {
    const s = await setup();
    await s.store.createOrg({ name: "Acme Two", ownerId: "root", id: "org-c" });
    const l = list(s, "orgs");
    const p1 = await l.list({ limit: 2 }, s.ctx);
    expect(p1.rows).toEqual([
      { id: "org-a", name: "Acme", createdBy: "alice", createdAt: expect.any(Number), members: 3 },
      { id: "org-b", name: "Beta", createdBy: "bob", createdAt: expect.any(Number), members: 2 },
    ]);
    const p2 = await l.list({ limit: 2, cursor: p1.next }, s.ctx);
    expect(p2.rows.map((r) => r.id)).toEqual(["org-c"]);
    expect(p2.next).toBeUndefined();
    expect((await l.list({ limit: 10, search: "acme" }, s.ctx)).rows.map((r) => r.id)).toEqual(["org-a", "org-c"]);
    expect((await l.list({ limit: 10, search: "%" }, s.ctx)).rows).toEqual([]);
  });

  test("members list pages across orgs, searches by email or user id, filters by role, and finds an org by exact id", async () => {
    const s = await setup();
    const l = list(s, "members");
    expect(l.filters!.find((f) => f.key === "role")!.options).toEqual(["owner", "admin", "member"]);
    const all: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await l.list({ limit: 2, cursor }, s.ctx);
      all.push(...page.rows);
      cursor = page.next;
    } while (cursor && all.length < 50);
    expect(all).toEqual([
      { id: memberId("org-a", "alice"), orgId: "org-a", orgName: "Acme", userId: "alice", email: "alice@example.com", role: "owner", createdAt: expect.any(Number) },
      { id: memberId("org-a", "carol"), orgId: "org-a", orgName: "Acme", userId: "carol", email: "carol@example.com", role: "member", createdAt: expect.any(Number) },
      { id: memberId("org-a", "dave"), orgId: "org-a", orgName: "Acme", userId: "dave", email: "dave@example.com", role: "admin", createdAt: expect.any(Number) },
      { id: memberId("org-b", "bob"), orgId: "org-b", orgName: "Beta", userId: "bob", email: "bob@example.com", role: "owner", createdAt: expect.any(Number) },
      { id: memberId("org-b", "carol"), orgId: "org-b", orgName: "Beta", userId: "carol", email: "carol@example.com", role: "member", createdAt: expect.any(Number) },
    ]);
    expect((await l.list({ limit: 10, search: "carol" }, s.ctx)).rows.map((r) => r.id)).toEqual([memberId("org-a", "carol"), memberId("org-b", "carol")]);
    expect((await l.list({ limit: 10, filters: { role: "owner" } }, s.ctx)).rows.map((r) => r.userId)).toEqual(["alice", "bob"]);
    expect((await l.list({ limit: 10, search: "org-b" }, s.ctx)).rows.map((r) => r.userId)).toEqual(["bob", "carol"]);
    expect((await l.list({ limit: 10, search: "org-" }, s.ctx)).rows).toEqual([]);
    expect((await l.list({ limit: 10, search: "_" }, s.ctx)).rows).toEqual([]);
  });

  test("changeRole changes a member's role now; refuses unknown roles and the last owner", async () => {
    const s = await setup();
    const a = rowAction(list(s, "members"), "changeRole");
    expect(a.danger).toBe(true);
    expect(validate(a.input!, { id: memberId("org-a", "carol"), role: "superuser" }).ok).toBe(false);
    expect(String(await run(s, a, { id: memberId("org-a", "carol"), role: "admin" }))).toContain("admin");
    expect(await s.store.getMembership("org-a", "carol")).toEqual({ role: "admin" });
    expect(String(await run(s, a, { id: memberId("org-a", "carol"), role: "admin" }))).toContain("already");
    await expect(Promise.resolve().then(() => run(s, a, { id: memberId("org-b", "bob"), role: "member" }))).rejects.toMatchObject({ code: "MIU_E_ACCESS_LAST_OWNER" });
    await expect(Promise.resolve().then(() => run(s, a, { id: memberId("org-b", "nobody"), role: "member" }))).rejects.toMatchObject({ code: "MIU_E_NOT_FOUND" });
    await expect(Promise.resolve().then(() => run(s, a, { id: "garbage", role: "member" }))).rejects.toMatchObject({ code: "MIU_E_BAD_REQUEST" });
  });

  test("removeMember removes now (danger), is idempotent, and keeps the last owner", async () => {
    const s = await setup();
    const a = rowAction(list(s, "members"), "removeMember");
    expect(a.danger).toBe(true);
    expect(String(await run(s, a, { id: memberId("org-a", "carol") }))).toContain("Removed");
    expect(await s.store.getMembership("org-a", "carol")).toBeNull();
    expect(String(await run(s, a, { id: memberId("org-a", "carol") }))).toContain("not a member");
    await expect(Promise.resolve().then(() => run(s, a, { id: memberId("org-b", "bob") }))).rejects.toMatchObject({ code: "MIU_E_ACCESS_LAST_OWNER" });
  });

  test("checkPermission explains a decision by org membership or by role", async () => {
    const s = await setup();
    const a = s.section.actions!.find((x) => x.name === "checkPermission")!;
    expect(a.danger).toBeFalsy();
    expect(await run(s, a, { permission: "contacts:delete", userId: "dave", orgId: "org-a" })).toEqual({ allowed: true, role: "admin", grantedBy: ["contacts:*"] });
    expect(await run(s, a, { permission: "contacts:delete", userId: "carol", orgId: "org-a" })).toEqual({ allowed: false, role: "member", grantedBy: [] });
    expect(await run(s, a, { permission: "contacts:read", role: "member" })).toEqual({ allowed: true, role: "member", grantedBy: ["contacts:read"] });
    const notMember = (await run(s, a, { permission: "contacts:read", userId: "carol", orgId: "nope" })) as { allowed: boolean; reason: string };
    expect(notMember.allowed).toBe(false);
    expect(notMember.reason).toContain("not a member");
    expect(validate(a.input!, { permission: "not a permission!" }).ok).toBe(false);
    await expect(Promise.resolve().then(() => run(s, a, { permission: "contacts:read" }))).rejects.toMatchObject({ code: "MIU_E_BAD_REQUEST" });
    await expect(Promise.resolve().then(() => run(s, a, { permission: "contacts:read", role: "ghost" }))).rejects.toMatchObject({ code: "MIU_E_ACCESS_ROLE_UNKNOWN" });
  });
});
