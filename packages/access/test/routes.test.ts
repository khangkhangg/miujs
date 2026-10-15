import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { d1, sqlite, type Database } from "@miujs/db";
import { access, accessStore, defineRoles, policy, type AccessOptions, type Mailer } from "../src/index.ts";
import { USERS, testAuth } from "./helpers.ts";

const BASE = "http://localhost";
const roles = defineRoles({
  owner: ["*"],
  admin: ["contacts:*", "members:*"],
  member: ["contacts:read"],
});

function makeMailer() {
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const mailer: Mailer = { send: (m) => void sent.push(m) };
  return { mailer, sent };
}

async function setup(opts: Partial<AccessOptions> = {}, appOpts: { dev?: boolean } = {}) {
  const database = sqlite();
  const store = accessStore(database);
  const app = miu({
    logLevel: "silent",
    mcp: true,
    dev: appOpts.dev ?? true,
    plugins: [testAuth(USERS), access({ roles, database, appUrl: "https://app.example.com", ...opts })],
  });
  const call = async (method: string, path: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (user) h["x-user"] = user;
    if (body !== undefined) h["content-type"] = "application/json";
    const res: Response = await app.fetch(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
  };
  return { app, database, store, call };
}

/** alice owns Acme; dave is admin; bob is member. Beta is owned by carol. */
async function seeded(opts: Partial<AccessOptions> = {}, appOpts: { dev?: boolean } = {}) {
  const s = await setup(opts, appOpts);
  const A = await s.store.createOrg({ name: "Acme", ownerId: "alice", ownerEmail: "alice@example.com" });
  const B = await s.store.createOrg({ name: "Beta", ownerId: "carol", ownerEmail: "carol@example.com" });
  await s.store.addMember(A.id, "dave", "admin", "dave@example.com");
  await s.store.addMember(A.id, "bob", "member", "bob@example.com");
  return { ...s, A, B };
}

describe("POST /orgs and GET /orgs", () => {
  test("creator becomes owner; GET /orgs lists only my orgs", async () => {
    const { call } = await setup();
    const created = await call("POST", "/orgs", "alice", { name: "Acme" });
    expect(created.status).toBe(201);
    expect(created.body.org).toMatchObject({ name: "Acme", role: "owner" });
    await call("POST", "/orgs", "bob", { name: "Bob's" });
    const mine = await call("GET", "/orgs", "alice");
    expect(mine.status).toBe(200);
    expect(mine.body.orgs.map((o: any) => [o.name, o.role])).toEqual([["Acme", "owner"]]);
  });
  test("signed out → 401; empty name → 400", async () => {
    const { call } = await setup();
    expect((await call("POST", "/orgs", undefined, { name: "x" })).status).toBe(401);
    expect((await call("GET", "/orgs")).status).toBe(401);
    expect((await call("POST", "/orgs", "alice", { name: "" })).status).toBe(400);
  });
});

describe("GET /orgs/:orgId/members", () => {
  test("members with members:read see the list; others are refused", async () => {
    const { call, A } = await seeded();
    const ok = await call("GET", `/orgs/${A.id}/members`, "dave");
    expect(ok.status).toBe(200);
    expect(ok.body.members.map((m: any) => [m.userId, m.role]).sort()).toEqual([["alice", "owner"], ["bob", "member"], ["dave", "admin"]]);
    const member = await call("GET", `/orgs/${A.id}/members`, "bob");
    expect(member.status).toBe(403);
    expect(member.body.error.fix).toContain("members:read");
  });
  test("another tenant's owner cannot list members (403 NOT_MEMBER, no data)", async () => {
    const { call, A } = await seeded();
    const res = await call("GET", `/orgs/${A.id}/members`, "carol");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MIU_E_ACCESS_NOT_MEMBER");
    expect(res.text).not.toContain("alice");
  });
  test("a header pointing at my own org does not unlock another org in the path", async () => {
    const { call, A, B } = await seeded();
    const res = await call("GET", `/orgs/${A.id}/members`, "carol", undefined, { "x-org-id": B.id });
    expect(res.status).toBe(403);
  });
});

describe("invitations", () => {
  test("creates an invite, emails the link, stores only a SHA-256 of the token", async () => {
    const { mailer, sent } = makeMailer();
    const { call, database, A } = await seeded({ mailer });
    const res = await call("POST", `/orgs/${A.id}/invites`, "alice", { email: "New.Person@Example.com", role: "member" });
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({ email: "new.person@example.com", role: "member" });
    expect(res.body.invite.expiresAt - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(res.body.invite.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    expect(res.body.inviteUrl).toBeUndefined();
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("new.person@example.com");
    const url = sent[0].text.match(/https:\/\/app\.example\.com\/invites\/([A-Za-z0-9_-]+)/);
    expect(url).not.toBeNull();
    const token = url![1];
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(sent[0].html).toContain(token);
    const row: any = await database.prepare("SELECT * FROM access_invites").first();
    expect(JSON.stringify(row)).not.toContain(token);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    expect(row.token_hash).toBe([...digest].map((b) => b.toString(16).padStart(2, "0")).join(""));
    expect(res.text).not.toContain(token);
  });

  test("tokens are random: two invites never share a token", async () => {
    const { mailer, sent } = makeMailer();
    const { call, A } = await seeded({ mailer });
    await call("POST", `/orgs/${A.id}/invites`, "alice", { email: "x@example.com", role: "member" });
    await call("POST", `/orgs/${A.id}/invites`, "alice", { email: "y@example.com", role: "member" });
    const tok = (i: number) => sent[i].text.match(/invites\/([A-Za-z0-9_-]+)/)![1];
    expect(tok(0)).not.toBe(tok(1));
  });

  test("org names are escaped in the email HTML and stripped of newlines in the subject", async () => {
    const { mailer, sent } = makeMailer();
    const { call, store } = await setup({ mailer });
    const org = await store.createOrg({ name: '<img src=x onerror=alert(1)>\r\nBcc: evil@x.com', ownerId: "alice" });
    await call("POST", `/orgs/${org.id}/invites`, "alice", { email: "x@example.com", role: "member" });
    expect(sent[0].html).not.toContain("<img");
    expect(sent[0].html).toContain("&lt;img");
    expect(sent[0].subject).not.toMatch(/[\r\n]/);
  });

  test("no mailer: the invite URL is returned in dev only", async () => {
    const dev = await seeded({}, { dev: true });
    const res = await dev.call("POST", `/orgs/${dev.A.id}/invites`, "alice", { email: "x@example.com", role: "member" });
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(/^https:\/\/app\.example\.com\/invites\/[A-Za-z0-9_-]{43,}$/);

    const prod = await seeded({}, { dev: false });
    const p = await prod.call("POST", `/orgs/${prod.A.id}/invites`, "alice", { email: "x@example.com", role: "member" });
    expect(p.status).toBe(500);
    expect(p.body.error.code).toBe("MIU_E_ACCESS_MAILER_MISSING");
    expect(p.text).not.toMatch(/invites\/[A-Za-z0-9_-]{43}/);
    expect(await prod.database.prepare("SELECT COUNT(*) AS n FROM access_invites").first("n")).toBe(0);
  });

  test("production without appUrl refuses to build links from the Host header", async () => {
    const { mailer } = makeMailer();
    const s = await seeded({ mailer, appUrl: undefined }, { dev: false });
    const res = await s.call("POST", `/orgs/${s.A.id}/invites`, "alice", { email: "x@example.com", role: "member" }, { host: "evil.example" });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("MIU_E_ACCESS_APP_URL_MISSING");
  });

  test("permission and role checks: members cannot invite; admins cannot invite owners; unknown roles rejected", async () => {
    const { call, A } = await seeded();
    const m = await call("POST", `/orgs/${A.id}/invites`, "bob", { email: "x@example.com", role: "member" });
    expect(m.status).toBe(403);
    expect(m.body.error.fix).toContain("members:invite");
    const up = await call("POST", `/orgs/${A.id}/invites`, "dave", { email: "x@example.com", role: "owner" });
    expect(up.status).toBe(403);
    expect(up.body.error.code).toBe("MIU_E_ACCESS_ROLE_TOO_HIGH");
    const ok = await call("POST", `/orgs/${A.id}/invites`, "dave", { email: "x@example.com", role: "admin" });
    expect(ok.status).toBe(201);
    const unknown = await call("POST", `/orgs/${A.id}/invites`, "alice", { email: "x@example.com", role: "god" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("MIU_E_ACCESS_ROLE_UNKNOWN");
    const proto = await call("POST", `/orgs/${A.id}/invites`, "alice", { email: "x@example.com", role: "__proto__" });
    expect(proto.status).toBe(400);
  });

  test("inviting an existing member → 409", async () => {
    const { call, A } = await seeded();
    const res = await call("POST", `/orgs/${A.id}/invites`, "alice", { email: "BOB@example.com", role: "member" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MIU_E_ACCESS_ALREADY_MEMBER");
  });

  async function invite(s: Awaited<ReturnType<typeof seeded>>, email: string, role = "member") {
    const res = await s.call("POST", `/orgs/${s.A.id}/invites`, "alice", { email, role });
    expect(res.status).toBe(201);
    return (res.body.inviteUrl as string).split("/invites/")[1];
  }

  test("accept: signed in with the invited email (case-insensitive) → joins with the role", async () => {
    const s = await seeded();
    const token = await invite(s, "carol@example.com", "admin"); // USERS.carol is Carol@Example.com
    const res = await s.call("POST", `/invites/${token}/accept`, "carol");
    expect(res.status).toBe(200);
    expect(res.body.org).toEqual({ id: s.A.id, name: "Acme", role: "admin" });
    expect(await s.store.getMembership(s.A.id, "carol")).toEqual({ role: "admin" });
  });

  test("an invite dies with its inviter's right to grant it (removed or demoted)", async () => {
    for (const change of ["remove", "demote"] as const) {
      const s = await seeded();
      const res = await s.call("POST", `/orgs/${s.A.id}/invites`, "dave", { email: "carol@example.com", role: "admin" });
      expect(res.status).toBe(201);
      const token = (res.body.inviteUrl as string).split("/invites/")[1];
      if (change === "remove") expect((await s.call("DELETE", `/orgs/${s.A.id}/members/dave`, "alice")).status).toBe(204);
      else expect((await s.call("PATCH", `/orgs/${s.A.id}/members/dave`, "alice", { role: "member" })).status).toBe(200);
      const acc = await s.call("POST", `/invites/${token}/accept`, "carol");
      expect(acc.status).toBe(410);
      expect(acc.body.error.code).toBe("MIU_E_ACCESS_INVITE_REVOKED");
      expect(await s.store.getMembership(s.A.id, "carol")).toBeNull();
    }
  });

  test("accept is single-use", async () => {
    const s = await seeded();
    const token = await invite(s, "carol@example.com");
    expect((await s.call("POST", `/invites/${token}/accept`, "carol")).status).toBe(200);
    await s.store.removeMember(s.A.id, "carol");
    const again = await s.call("POST", `/invites/${token}/accept`, "carol");
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe("MIU_E_ACCESS_INVITE_USED");
    expect(await s.store.getMembership(s.A.id, "carol")).toBeNull();
  });

  test("store.consumeInvite is atomic and single-use on its own (not just via the route's pre-check)", async () => {
    const s = await seeded();
    await invite(s, "carol@example.com");
    const id = await s.database.prepare("SELECT id FROM access_invites").first<string>("id");
    const now = Date.now();
    expect(await s.store.consumeInvite(id!, "carol", now)).toBe(true);
    expect(await s.store.consumeInvite(id!, "root", now)).toBe(false);
    expect(await s.database.prepare("SELECT accepted_by FROM access_invites").first("accepted_by")).toBe("carol");
  });

  test("store.consumeInvite refuses expired invites", async () => {
    const s = await seeded();
    await invite(s, "carol@example.com");
    const id = await s.database.prepare("SELECT id FROM access_invites").first<string>("id");
    expect(await s.store.consumeInvite(id!, "carol", Date.now() + 8 * 86_400_000)).toBe(false);
  });

  test("concurrent accepts of one token: exactly one wins", async () => {
    const s = await seeded({ allowAnyEmail: true });
    const token = await invite(s, "someone@example.com");
    const results = await Promise.all(["carol", "root", "carol"].map((u) => s.call("POST", `/invites/${token}/accept`, u)));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });

  test("accept requires sign-in", async () => {
    const s = await seeded();
    const token = await invite(s, "carol@example.com");
    expect((await s.call("POST", `/invites/${token}/accept`)).status).toBe(401);
  });

  test("a different signed-in user cannot accept (403), and the invite stays usable", async () => {
    const s = await seeded();
    const token = await invite(s, "carol@example.com");
    const res = await s.call("POST", `/invites/${token}/accept`, "root");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MIU_E_ACCESS_INVITE_EMAIL_MISMATCH");
    expect(await s.store.getMembership(s.A.id, "root")).toBeNull();
    expect((await s.call("POST", `/invites/${token}/accept`, "carol")).status).toBe(200);
  });

  test("a user without an email cannot accept an email-bound invite", async () => {
    const s = await seeded();
    const token = await invite(s, "carol@example.com");
    USERS.noemail = { roles: [] };
    try {
      expect((await s.call("POST", `/invites/${token}/accept`, "noemail")).status).toBe(403);
    } finally {
      delete USERS.noemail;
    }
  });

  describe("email verification (auth sets ctx.user.emailVerified only when it is on)", () => {
    const as = async (emailVerified: boolean | undefined, fn: () => Promise<void>) => {
      const prev = USERS.carol;
      USERS.carol = emailVerified === undefined ? { ...prev } : { ...prev, emailVerified };
      try {
        await fn();
      } finally {
        USERS.carol = prev;
      }
    };

    test("emailVerified === false → 403 MIU_E_ACCESS_EMAIL_UNVERIFIED with a fix; the invite stays usable", async () => {
      const s = await seeded();
      const token = await invite(s, "carol@example.com");
      await as(false, async () => {
        const res = await s.call("POST", `/invites/${token}/accept`, "carol");
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("MIU_E_ACCESS_EMAIL_UNVERIFIED");
        expect(res.body.error.fix).toBeTruthy();
      });
      expect(await s.store.getMembership(s.A.id, "carol")).toBeNull();
      await as(true, async () => {
        expect((await s.call("POST", `/invites/${token}/accept`, "carol")).status).toBe(200);
      });
    });

    test("emailVerified === false is refused even with allowAnyEmail", async () => {
      const s = await seeded({ allowAnyEmail: true });
      const token = await invite(s, "carol@example.com");
      await as(false, async () => {
        expect((await s.call("POST", `/invites/${token}/accept`, "carol")).status).toBe(403);
      });
    });

    test("emailVerified absent (verification off) → accepted as before", async () => {
      const s = await seeded();
      const token = await invite(s, "carol@example.com");
      await as(undefined, async () => {
        expect((await s.call("POST", `/invites/${token}/accept`, "carol")).status).toBe(200);
      });
    });
  });

  test("allowAnyEmail lets any signed-in user accept", async () => {
    const s = await seeded({ allowAnyEmail: true });
    const token = await invite(s, "carol@example.com");
    expect((await s.call("POST", `/invites/${token}/accept`, "root")).status).toBe(200);
    expect(await s.store.getMembership(s.A.id, "root")).toEqual({ role: "member" });
  });

  test("expired invites are refused (410)", async () => {
    const s = await seeded();
    const token = await invite(s, "carol@example.com");
    await s.database.prepare("UPDATE access_invites SET expires_at = ?").bind(Date.now() - 1).run();
    const res = await s.call("POST", `/invites/${token}/accept`, "carol");
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("MIU_E_ACCESS_INVITE_EXPIRED");
    expect(await s.store.getMembership(s.A.id, "carol")).toBeNull();
  });

  test("inviteTtlDays changes the expiry", async () => {
    const s = await seeded({ inviteTtlDays: 1 });
    const res = await s.call("POST", `/orgs/${s.A.id}/invites`, "alice", { email: "x@example.com", role: "member" });
    expect(res.body.invite.expiresAt - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  test("unknown or garbage tokens → 404 MIU_E_ACCESS_INVITE_INVALID", async () => {
    const s = await seeded();
    for (const t of ["nope", "A".repeat(43), "%27%20OR%201%3D1"]) {
      const res = await s.call("POST", `/invites/${t}/accept`, "carol");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("MIU_E_ACCESS_INVITE_INVALID");
    }
  });

  test("the token hash is not accepted as a token", async () => {
    const s = await seeded();
    await invite(s, "carol@example.com");
    const hash = await s.database.prepare("SELECT token_hash FROM access_invites").first<string>("token_hash");
    expect((await s.call("POST", `/invites/${hash}/accept`, "carol")).status).toBe(404);
  });

  test("accepting when already a member keeps the existing role (no downgrade, no upgrade)", async () => {
    const s = await seeded({ allowAnyEmail: true });
    const token = await invite(s, "someone@example.com", "admin");
    const res = await s.call("POST", `/invites/${token}/accept`, "bob");
    expect(res.status).toBe(200);
    expect(await s.store.getMembership(s.A.id, "bob")).toEqual({ role: "member" });
  });

  test("a newer invite to the same email replaces the older one", async () => {
    const s = await seeded();
    const first = await invite(s, "carol@example.com");
    const second = await invite(s, "carol@example.com");
    expect((await s.call("POST", `/invites/${first}/accept`, "carol")).status).toBe(404);
    expect((await s.call("POST", `/invites/${second}/accept`, "carol")).status).toBe(200);
  });
});

describe("PATCH/DELETE /orgs/:orgId/members/:userId", () => {
  test("owner changes a role", async () => {
    const { call, store, A } = await seeded();
    const res = await call("PATCH", `/orgs/${A.id}/members/bob`, "alice", { role: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({ userId: "bob", role: "admin" });
    expect(await store.getMembership(A.id, "bob")).toEqual({ role: "admin" });
  });

  test("the last owner cannot be demoted or leave (409 MIU_E_ACCESS_LAST_OWNER)", async () => {
    const { call, store, A } = await seeded();
    const demote = await call("PATCH", `/orgs/${A.id}/members/alice`, "alice", { role: "admin" });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("MIU_E_ACCESS_LAST_OWNER");
    expect(demote.body.error.fix).toBeTruthy();
    const leave = await call("DELETE", `/orgs/${A.id}/members/alice`, "alice");
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe("MIU_E_ACCESS_LAST_OWNER");
    expect(await store.getMembership(A.id, "alice")).toEqual({ role: "owner" });
  });

  test("with two owners, one may step down; then the other is the last", async () => {
    const { call, store, A } = await seeded();
    await call("PATCH", `/orgs/${A.id}/members/dave`, "alice", { role: "owner" });
    expect((await call("PATCH", `/orgs/${A.id}/members/alice`, "alice", { role: "member" })).status).toBe(200);
    expect((await call("DELETE", `/orgs/${A.id}/members/dave`, "dave")).status).toBe(409);
    expect(await store.getMembership(A.id, "dave")).toEqual({ role: "owner" });
  });

  test("two owners demoting each other at the same time leave at least one owner", async () => {
    const { call, store, A } = await seeded();
    await store.setRole(A.id, "dave", "owner");
    await Promise.all([call("PATCH", `/orgs/${A.id}/members/alice`, "dave", { role: "member" }), call("PATCH", `/orgs/${A.id}/members/dave`, "alice", { role: "member" })]);
    const owners = (await store.listMembers(A.id)).filter((m) => m.role === "owner");
    expect(owners.length).toBe(1);
  });

  test("admins cannot touch owners or promote to owner", async () => {
    const { call, store, A } = await seeded();
    expect((await call("PATCH", `/orgs/${A.id}/members/alice`, "dave", { role: "member" })).status).toBe(403);
    expect((await call("PATCH", `/orgs/${A.id}/members/bob`, "dave", { role: "owner" })).status).toBe(403);
    expect((await call("PATCH", `/orgs/${A.id}/members/dave`, "dave", { role: "owner" })).status).toBe(403);
    expect((await call("DELETE", `/orgs/${A.id}/members/alice`, "dave")).status).toBe(403);
    expect(await store.getMembership(A.id, "alice")).toEqual({ role: "owner" });
    expect((await call("PATCH", `/orgs/${A.id}/members/bob`, "dave", { role: "admin" })).status).toBe(200);
  });

  test("members cannot manage others but may leave", async () => {
    const { call, store, A } = await seeded();
    const res = await call("DELETE", `/orgs/${A.id}/members/dave`, "bob");
    expect(res.status).toBe(403);
    expect(res.body.error.fix).toContain("members:manage");
    expect((await call("PATCH", `/orgs/${A.id}/members/bob`, "bob", { role: "admin" })).status).toBe(403);
    expect((await call("DELETE", `/orgs/${A.id}/members/bob`, "bob")).status).toBe(204);
    expect(await store.getMembership(A.id, "bob")).toBeNull();
  });

  test("unknown role → 400; unknown member → 404; other tenants' members are invisible", async () => {
    const { call, A } = await seeded();
    expect((await call("PATCH", `/orgs/${A.id}/members/bob`, "alice", { role: "god" })).status).toBe(400);
    expect((await call("PATCH", `/orgs/${A.id}/members/nobody`, "alice", { role: "member" })).status).toBe(404);
    // carol belongs to Beta only: from Acme she does not exist.
    expect((await call("DELETE", `/orgs/${A.id}/members/carol`, "alice")).status).toBe(404);
  });

  test("cross-tenant: an owner of A cannot change members of B", async () => {
    const { call, store, B } = await seeded();
    const res = await call("PATCH", `/orgs/${B.id}/members/carol`, "alice", { role: "member" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MIU_E_ACCESS_NOT_MEMBER");
    expect((await call("DELETE", `/orgs/${B.id}/members/carol`, "alice")).status).toBe(403);
    expect(await store.getMembership(B.id, "carol")).toEqual({ role: "owner" });
  });
});

describe("app integration", () => {
  test("routes have summaries; all but accept are MCP tools", async () => {
    const { app } = await setup();
    await app.ready();
    const info = app.inspect();
    const ours = info.routes.filter((r: any) => r.name.startsWith("access_"));
    expect(ours.length).toBe(7);
    for (const r of ours) {
      expect(r.summary).toBeTruthy();
      expect(r.auth).toBe("required");
    }
    expect(info.mcp!.tools).toContain("access_create_org");
    expect(info.mcp!.tools).not.toContain("access_accept_invite");
    expect(info.mcp!.tools.filter((n: string) => n.startsWith("access_")).length).toBe(6);
  });

  test("inspect lists roles and policies; routes: false serves none", async () => {
    const database = sqlite();
    const app = miu({ logLevel: "silent", plugins: [access({ roles, database, routes: false, policies: [policy("contacts", { update: () => true })] })] });
    await app.ready();
    const info = app.inspect();
    expect(info.routes.length).toBe(0);
    const p = info.plugins.find((x: any) => x.name === "access")!.info as any;
    expect(p.roles).toEqual(roles);
    expect(p.policies).toEqual([{ resource: "contacts", actions: ["update"] }]);
  });

  test("cloudflare() asks for D1 when the database is a d1 binding name", () => {
    expect(access({ roles, database: d1("DB") }).cloudflare!()).toEqual({ d1: ["DB"] });
    expect(access({ roles, database: sqlite() }).cloudflare!()).toEqual({});
    expect(access({ roles }).cloudflare!()).toEqual({});
  });

  test("works on a D1 binding resolved from env", async () => {
    const database: Database = sqlite();
    const store = accessStore(database);
    const A = await store.createOrg({ name: "Acme", ownerId: "alice" });
    const app = miu({ logLevel: "silent", plugins: [testAuth(USERS), access({ roles, database: d1("DB") })] });
    const res = await app.dispatch(new Request(`${BASE}/orgs/${A.id}/members`, { headers: { "x-user": "alice" } }), { DB: database }, { runtime: "bun" });
    expect(res.status).toBe(200);
  });
});
