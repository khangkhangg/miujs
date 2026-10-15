import { describe, expect, test } from "bun:test";
import { validate } from "miujs";
import { createSchema, field, resource, updateSchema } from "../src/index.ts";
import { fromDb, toDb, valueSchema } from "../src/fields.ts";

const ok = (s: ReturnType<typeof valueSchema>, v: unknown) => {
  const r = validate(s, v);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};
const bad = (s: ReturnType<typeof valueSchema>, v: unknown) => expect(validate(s, v).ok).toBe(false);

describe("field types: validation", () => {
  test("text honours max/min", () => {
    const s = valueSchema(field.text({ max: 3, min: 1 }));
    expect(ok(s, "abc")).toBe("abc");
    bad(s, "abcd");
    bad(s, "");
    bad(s, 5);
  });

  test("longText and richText; richText is sanitized on the way in", () => {
    expect(ok(valueSchema(field.longText()), "a\nb")).toBe("a\nb");
    const rt = field.richText();
    expect(toDb(rt, '<p onclick="x">hi<script>bad()</script></p>')).toBe("<p>hi</p>");
  });

  test("email, phone, url", () => {
    ok(valueSchema(field.email()), "a@b.co");
    bad(valueSchema(field.email()), "nope");
    ok(valueSchema(field.phone()), "+1 (555) 010-9999");
    bad(valueSchema(field.phone()), "call me");
    ok(valueSchema(field.url()), "https://miujs.dev/x");
    bad(valueSchema(field.url()), "javascript:alert(1)");
  });

  test("number, money, percent", () => {
    expect(ok(valueSchema(field.number({ min: 0 })), 1.5)).toBe(1.5);
    bad(valueSchema(field.number({ min: 0 })), -1);
    const money = field.money({ currency: "USD" });
    expect(ok(valueSchema(money), 1999)).toBe(1999);
    bad(valueSchema(money), 19.99); // integer minor units only
    ok(valueSchema(field.percent()), 42.5);
    bad(valueSchema(field.percent()), 101);
  });

  test("boolean, date, datetime", () => {
    expect(ok(valueSchema(field.boolean()), true)).toBe(true);
    expect(ok(valueSchema(field.date()), "2026-03-01")).toBe("2026-03-01");
    bad(valueSchema(field.date()), "2026-13-01");
    bad(valueSchema(field.date()), "2026-02-30");
    bad(valueSchema(field.date()), "March 1");
    const dt = field.datetime();
    const v = ok(valueSchema(dt), "2026-03-01T10:00:00Z");
    expect(toDb(dt, v)).toBe(Date.parse("2026-03-01T10:00:00Z"));
    expect(fromDb(dt, Date.parse("2026-03-01T10:00:00Z"))).toBe("2026-03-01T10:00:00.000Z");
  });

  test("select and multiSelect take strings or option objects", () => {
    const s = field.select(["lead", "won"]);
    ok(valueSchema(s), "lead");
    bad(valueSchema(s), "other");
    const s2 = field.select([{ value: "won", label: "Won", probability: 100 }]);
    expect(s2.options.choices).toEqual([{ value: "won", label: "Won", probability: 100 }]);
    const m = field.multiSelect(["a", "b"]);
    expect(ok(valueSchema(m), ["a", "b"])).toEqual(["a", "b"]);
    bad(valueSchema(m), ["c"]);
    expect(toDb(m, ["a"])).toBe('["a"]');
    expect(fromDb(m, '["a"]')).toEqual(["a"]);
  });

  test("tags are trimmed, deduplicated and stored as JSON", () => {
    const tg = field.tags();
    const v = ok(valueSchema(tg), [" vip ", "vip", "b2b"]);
    expect(v).toEqual(["vip", "b2b"]);
    bad(valueSchema(tg), ["x".repeat(101)]);
    expect(fromDb(tg, null)).toEqual([]);
  });

  test("relation, user, file, json", () => {
    ok(valueSchema(field.relation("companies")), "c1");
    bad(valueSchema(field.relation("companies")), 5);
    ok(valueSchema(field.user()), "u1");
    ok(valueSchema(field.file()), "uploads/2026/a.png");
    bad(valueSchema(field.file()), "../etc/passwd");
    bad(valueSchema(field.file()), "/abs/path");
    const j = field.json();
    expect(toDb(j, { a: [1] })).toBe('{"a":[1]}');
    expect(fromDb(j, '{"a":[1]}')).toEqual({ a: [1] });
  });

  test("boolean maps to 0/1", () => {
    expect(toDb(field.boolean(), true)).toBe(1);
    expect(fromDb(field.boolean(), 0)).toBe(false);
  });
});

describe("create/update schemas", () => {
  const contacts = resource("contacts", {
    fields: {
      name: field.text({ required: true, max: 200 }),
      stage: field.select(["lead", "customer"], { default: "lead" }),
      value: field.money({ currency: "USD" }),
    },
  });

  test("create: required fields required, defaults filled, others nullable", () => {
    expect(validate(createSchema(contacts), {}).ok).toBe(false);
    const r = validate(createSchema(contacts), { name: "Ann", value: null });
    expect(r).toEqual({ ok: true, value: { name: "Ann", stage: "lead", value: null } });
  });

  test("update: everything optional, required fields not nullable, unknown keys dropped", () => {
    expect(validate(updateSchema(contacts), { stage: "customer", orgId: "x", id: "y" })).toEqual({ ok: true, value: { stage: "customer" } });
    expect(validate(updateSchema(contacts), { name: null }).ok).toBe(false);
  });
});
