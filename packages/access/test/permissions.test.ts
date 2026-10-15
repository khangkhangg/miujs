import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { defineRoles, matchPermission, policy, roleAllows, roleCovers, evaluate } from "../src/index.ts";

const roles = defineRoles({
  owner: ["*"],
  admin: ["contacts:*", "deals:*", "members:*"],
  member: ["contacts:read", "contacts:create"],
  auditor: ["*:read"],
});

describe("matchPermission", () => {
  test("exact match", () => {
    expect(matchPermission("contacts:read", "contacts:read")).toBe(true);
    expect(matchPermission("contacts:read", "contacts:update")).toBe(false);
    expect(matchPermission("contacts:read", "deals:read")).toBe(false);
  });
  test("* matches everything", () => {
    expect(matchPermission("*", "contacts:read")).toBe(true);
    expect(matchPermission("*", "anything:else")).toBe(true);
  });
  test("resource:* matches every action on that resource only", () => {
    expect(matchPermission("contacts:*", "contacts:delete")).toBe(true);
    expect(matchPermission("contacts:*", "deals:delete")).toBe(false);
    expect(matchPermission("contacts:*", "contactsx:read")).toBe(false);
  });
  test("*:action matches the action on any resource", () => {
    expect(matchPermission("*:read", "deals:read")).toBe(true);
    expect(matchPermission("*:read", "deals:update")).toBe(false);
  });
  test("a narrow pattern never matches a wildcard request (no escalation)", () => {
    expect(matchPermission("contacts:read", "contacts:*")).toBe(false);
    expect(matchPermission("contacts:read", "*")).toBe(false);
    expect(matchPermission("contacts:*", "*")).toBe(false);
    expect(matchPermission("contacts:*", "contacts:*")).toBe(true);
  });
  test("segment counts must agree; no prefix tricks", () => {
    expect(matchPermission("contacts:read", "contacts:read:extra")).toBe(false);
    expect(matchPermission("contacts", "contacts:read")).toBe(false);
    expect(matchPermission("", "")).toBe(false);
  });
});

describe("defineRoles", () => {
  test("returns the roles and rejects malformed permissions", () => {
    expect(Object.keys(roles)).toEqual(["owner", "admin", "member", "auditor"]);
    for (const bad of ["contacts", "contacts:", ":read", "a:b:c", "Contacts Read", ""]) {
      let err: unknown;
      try {
        defineRoles({ x: [bad] });
      } catch (e) {
        err = e;
      }
      expect(isMiuError(err)).toBe(true);
      expect((err as any).code).toBe("MIU_E_ACCESS_PERMISSION_INVALID");
      expect((err as any).fix).toBeTruthy();
    }
  });
  test("roleAllows checks a role's permissions; unknown role allows nothing", () => {
    expect(roleAllows(roles, "owner", "billing:delete")).toBe(true);
    expect(roleAllows(roles, "admin", "contacts:delete")).toBe(true);
    expect(roleAllows(roles, "admin", "billing:read")).toBe(false);
    expect(roleAllows(roles, "member", "contacts:read")).toBe(true);
    expect(roleAllows(roles, "member", "contacts:update")).toBe(false);
    expect(roleAllows(roles, "ghost", "contacts:read")).toBe(false);
    expect(roleAllows(roles, "__proto__", "contacts:read")).toBe(false);
    expect(roleAllows(roles, "constructor", "contacts:read")).toBe(false);
  });
  test("roleCovers: may a holder of role A hand out role B?", () => {
    expect(roleCovers(roles, "owner", "admin")).toBe(true);
    expect(roleCovers(roles, "owner", "owner")).toBe(true);
    expect(roleCovers(roles, "admin", "member")).toBe(true);
    expect(roleCovers(roles, "admin", "owner")).toBe(false);
    expect(roleCovers(roles, "member", "admin")).toBe(false);
    expect(roleCovers(roles, "auditor", "member")).toBe(false);
    expect(roleCovers(roles, "admin", "ghost")).toBe(false);
  });
});

describe("policies (row-level, on top of role permissions)", () => {
  const contacts = policy("contacts", {
    update: ({ user, record, can }) => record.ownerId === user.id || can("contacts:manage"),
  });
  const policies = [contacts];
  const ev = (role: string, perm: string, record?: any, userId = "u1") =>
    evaluate({ roles, policies, user: { id: userId, roles: [] }, org: { id: "o1", role }, roleNames: [role] }, perm, record);

  test("role permission is still required: member lacks contacts:update even on own record", () => {
    expect(ev("member", "contacts:update", { ownerId: "u1" }).ok).toBe(false);
  });
  test("policy allows the record owner", () => {
    const r2 = defineRoles({ editor: ["contacts:update"] });
    const e = (record: any) => evaluate({ roles: r2, policies, user: { id: "u1", roles: [] }, org: { id: "o1", role: "editor" }, roleNames: ["editor"] }, "contacts:update", record);
    expect(e({ ownerId: "u1" }).ok).toBe(true);
    const denied = e({ ownerId: "u2" });
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.reason).toBe("policy");
  });
  test("policy can defer to another permission via can()", () => {
    expect(ev("admin", "contacts:update", { ownerId: "someone-else" }).ok).toBe(true);
  });
  test("without a record the policy is not consulted (role check only)", () => {
    expect(ev("admin", "contacts:update").ok).toBe(true);
  });
  test("a throwing policy denies (fails closed)", () => {
    const boom = policy("deals", { update: () => { throw new Error("bug"); } });
    const r = evaluate({ roles, policies: [boom], user: { id: "u1", roles: [] }, org: null, roleNames: ["admin"] }, "deals:update", {});
    expect(r.ok).toBe(false);
  });
  test("a policy returning a truthy non-boolean does not allow", () => {
    const weird = policy("deals", { update: () => "yes" as any });
    const r = evaluate({ roles, policies: [weird], user: { id: "u1", roles: [] }, org: null, roleNames: ["admin"] }, "deals:update", {});
    expect(r.ok).toBe(false);
  });
  test("a wildcard request with a record runs every rule it covers (no policy bypass)", () => {
    const r2 = defineRoles({ boss: ["*"], cm: ["contacts:*"] });
    const e = (role: string, perm: string, record: any) => evaluate({ roles: r2, policies, user: { id: "u1", roles: [] }, org: { id: "o1", role }, roleNames: [role] }, perm, record);
    // "contacts:update" denies u1 on u2's record (u1 lacks contacts:manage under cm? cm has contacts:* so can() passes)
    const own = policy("deals", { update: ({ user, record }) => record.ownerId === user.id, read: () => true });
    const e2 = (perm: string, record: any) => evaluate({ roles: r2, policies: [own], user: { id: "u1", roles: [] }, org: { id: "o1", role: "boss" }, roleNames: ["boss"] }, perm, record);
    expect(e2("deals:update", { ownerId: "u2" }).ok).toBe(false);
    expect(e2("deals:*", { ownerId: "u2" }).ok).toBe(false);
    expect(e2("*", { ownerId: "u2" }).ok).toBe(false);
    expect(e2("deals:*", { ownerId: "u1" }).ok).toBe(true);
    expect(e("cm", "contacts:*", { ownerId: "u2" }).ok).toBe(true); // contacts:manage via can() allows
  });
  test("no user → never allowed", () => {
    expect(evaluate({ roles, policies, user: undefined, org: null, roleNames: ["owner"] }, "contacts:read").ok).toBe(false);
  });
  test("policy rejects bad definitions", () => {
    expect(() => policy("", { update: () => true })).toThrow();
    expect(() => policy("contacts", { update: "x" as any })).toThrow();
  });
});
