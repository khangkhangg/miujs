import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { field, resource } from "../src/index.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (isMiuError(e)) {
      expect(e.fix).toBeTruthy();
      return e.code;
    }
    throw e;
  }
  return undefined;
}

describe("resource()", () => {
  test("defaults", () => {
    const r = resource("contacts", { fields: { fullName: field.text({ required: true }) } });
    expect(r.name).toBe("contacts");
    expect(r.label).toBe("Contacts");
    expect(r.table).toBe("contacts");
    expect(r.tenant).toBe(false);
    expect(r.softDelete).toBe(false);
    expect(r.timestamps).toBe(true);
    expect(r.permissions).toEqual({
      read: "contacts:read",
      create: "contacts:create",
      update: "contacts:update",
      delete: "contacts:delete",
      export: "contacts:export",
      import: "contacts:import",
    });
    expect(r.titleField).toBe("fullName");
    expect(r.fields.fullName.label).toBe("Full name");
    expect(r.fields.fullName.column).toBe("full_name");
  });

  test("permissions prefix and opting out", () => {
    expect(resource("deals", { fields: {}, permissions: "crm" }).permissions!.read).toBe("crm:read");
    expect(resource("deals", { fields: {}, permissions: false }).permissions).toBeNull();
  });

  test("invalid names", () => {
    expect(codeOf(() => resource("Bad Name", { fields: {} }))).toBe("MIU_E_ADMIN_RESOURCE_INVALID");
    expect(codeOf(() => resource("ok", { fields: { "bad-name": field.text() } }))).toBe("MIU_E_ADMIN_FIELD_INVALID");
    expect(codeOf(() => resource("ok", { fields: { x: { type: "text" } as never } }))).toBe("MIU_E_ADMIN_FIELD_INVALID");
  });

  test("reserved field names", () => {
    for (const n of ["id", "orgId", "createdAt", "updatedBy", "deletedAt", "sort", "filter", "cursor", "limit", "q", "fields", "view", "include"]) {
      expect(codeOf(() => resource("ok", { fields: { [n]: field.text() } }))).toBe("MIU_E_ADMIN_FIELD_RESERVED");
    }
  });

  test("defaults must be valid", () => {
    expect(codeOf(() => resource("ok", { fields: { s: field.select(["a"], { default: "b" }) } }))).toBe("MIU_E_ADMIN_FIELD_INVALID");
  });

  test("views are checked", () => {
    const fields = { stage: field.select(["a", "b"]), name: field.text(), due: field.date() };
    expect(codeOf(() => resource("ok", { fields, views: { k: { kind: "kanban", groupBy: "name" } } }))).toBe("MIU_E_ADMIN_VIEW_INVALID");
    expect(codeOf(() => resource("ok", { fields, views: { k: { filter: { nope: { eq: 1 } } } } }))).toBe("MIU_E_ADMIN_VIEW_INVALID");
    expect(codeOf(() => resource("ok", { fields, views: { k: { sort: "nope" } } }))).toBe("MIU_E_ADMIN_VIEW_INVALID");
    expect(codeOf(() => resource("ok", { fields, views: { k: { kind: "calendar" } } }))).toBe("MIU_E_ADMIN_VIEW_INVALID");
    const r = resource("ok", { fields, views: { board: { kind: "kanban", groupBy: "stage" }, soon: { filter: { due: { gte: "today" } }, sort: "-due" } } });
    expect(r.views.board).toMatchObject({ kind: "kanban", groupBy: "stage", label: "Board" });
    expect(r.views.soon).toMatchObject({ kind: "table", sort: "-due" });
  });

  test("actions need run functions and valid permissions", () => {
    expect(codeOf(() => resource("ok", { fields: {}, actions: { a: { label: "A" } as never } }))).toBe("MIU_E_ADMIN_ACTION_INVALID");
    expect(codeOf(() => resource("ok", { fields: {}, actions: { a: { run: () => 1, permission: "bad perm" } } }))).toBe("MIU_E_ADMIN_ACTION_INVALID");
    const r = resource("ok", { fields: {}, actions: { markLost: { run: () => 1 } } });
    expect(r.actions.markLost).toMatchObject({ label: "Mark lost", permission: "ok:update" });
  });

  test("search needs searchable text fields", () => {
    expect(codeOf(() => resource("ok", { fields: { n: field.number() }, search: true }))).toBe("MIU_E_ADMIN_SEARCH_INVALID");
    expect(codeOf(() => resource("ok", { fields: { n: field.number({ searchable: true } as never) } }))).toBe("MIU_E_ADMIN_FIELD_INVALID");
  });
});
