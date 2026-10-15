import { describe, expect, test } from "bun:test";
import { adminSchema, type FieldMeta } from "../../src/index.ts";
import { changedOnly, displayValue, fieldErrors, formToBody, renderField } from "../../src/ui/form.ts";
import { XSS, uiResources } from "./fixtures.ts";

const fields = adminSchema(uiResources()).resources[1].fields;
const f = (n: string) => fields.find((x) => x.name === n)! as FieldMeta;
const s = (x: unknown) => String(x);

describe("form → API body", () => {
  test("create: converts by type and omits empty values", () => {
    const out = formToBody(
      fields,
      {
        name: " Ann ",
        bio: "",
        score: "42",
        value: "12.34",
        chance: "50",
        _bool: ["vip"],
        vip: "true",
        birthday: "2026-03-01",
        lastSeen: "2026-03-01T09:30",
        stage: "lead",
        _multi: ["channels"],
        channels: ["email", "phone"],
        tags: "a, b,,a",
        company: "c1",
        meta: '{"k":[1]}',
        secret: "nope",
        id: "forged",
      },
      "create",
    );
    expect(out.errors).toEqual({});
    expect(out.body).toEqual({
      name: "Ann",
      score: 42,
      value: 1234,
      chance: 50,
      vip: true,
      birthday: "2026-03-01",
      lastSeen: "2026-03-01T09:30:00.000Z",
      stage: "lead",
      channels: ["email", "phone"],
      tags: ["a", "b"],
      company: "c1",
      meta: { k: [1] },
    });
  });

  test("update: empty optional fields become null; unchecked boxes false; no multi → []", () => {
    const out = formToBody(fields, { name: "Ann", bio: "", _bool: ["vip"], _multi: ["channels"], score: "" }, "update");
    expect(out.body).toMatchObject({ name: "Ann", bio: null, vip: false, channels: [], score: null });
  });

  test("errors are per field", () => {
    const out = formToBody(fields, { name: "A", score: "lots", value: "1.234", meta: "{", lastSeen: "yesterday" }, "create");
    expect(Object.keys(out.errors).sort()).toEqual(["lastSeen", "meta", "score", "value"]);
    expect(out.errors.value).toContain("2 decimal");
  });

  test("changedOnly keeps fields whose value differs", () => {
    expect(changedOnly({ name: "A", tags: ["x"], vip: false, bio: null }, { name: "A", tags: ["x"], vip: true, bio: null, score: 3 })).toEqual({ vip: true, score: 3 });
  });
});

describe("API error → field messages", () => {
  test("validation issues map to fields by path; the rest are general", () => {
    const e = { error: { code: "MIU_E_VALIDATION", message: "Invalid body", details: { issues: [{ path: "body.email", message: "must be an email" }, { path: "body.tags.0", message: "too long" }, { path: "body", message: "bad" }] } } };
    expect(fieldErrors(e, fields)).toEqual({ fields: { email: ["must be an email"], tags: ["too long"] }, general: ["bad"] });
  });

  test("unique / relation errors carry details.field", () => {
    expect(fieldErrors({ error: { code: "MIU_E_ADMIN_UNIQUE", message: "Another contact already has this email", details: { field: "email" } } }, fields)).toEqual({
      fields: { email: ["Another contact already has this email"] },
      general: [],
    });
    expect(fieldErrors({ error: { code: "X", message: "Nope", fix: "Do this" } }, fields)).toEqual({ fields: {}, general: ["Nope Do this"] });
  });
});

describe("rendering fields", () => {
  test("labels, ids, help, required and errors are wired for assistive tech", () => {
    const h = s(renderField(f("name"), "Ann", { errors: ["is required"] }));
    expect(h).toContain('<label for="f-name">');
    expect(h).toContain('id="f-name" name="name"');
    expect(h).toContain("required");
    expect(h).toContain('aria-invalid="true"');
    expect(h).toContain('aria-describedby="f-name-err"');
    expect(h).toContain('<p class="field-error" id="f-name-err">is required</p>');
  });

  test("values, labels and options are escaped", () => {
    const bad = s(renderField(f("name"), XSS));
    expect(bad).not.toContain("<script>");
    expect(bad).toContain("&lt;script&gt;");
    expect(s(renderField(f("bio"), ""))).not.toContain("<script>");
    const sel = s(renderField(f("stage"), "lost"));
    expect(sel).not.toContain("<script>");
    expect(sel).toContain('<option value="lost" selected>Lost &quot;&gt;&lt;script&gt;');
  });

  test("each type gets the right control", () => {
    expect(s(renderField(f("bio"), "x"))).toContain("<textarea");
    expect(s(renderField(f("email"), ""))).toContain('type="email"');
    expect(s(renderField(f("phone"), ""))).toContain('type="tel"');
    expect(s(renderField(f("site"), ""))).toContain('type="url"');
    expect(s(renderField(f("score"), 3))).toContain('type="number" step="1" min="0" max="100"');
    expect(s(renderField(f("value"), 1234))).toMatch(/type="number" step="0.01"[^>]*value="12.34"/);
    expect(s(renderField(f("vip"), true))).toMatch(/type="checkbox"[^>]*value="true" checked/);
    expect(s(renderField(f("birthday"), "2026-03-01"))).toContain('type="date"');
    expect(s(renderField(f("lastSeen"), "2026-03-01T09:30:00.000Z"))).toMatch(/type="datetime-local"[^>]*value="2026-03-01T09:30"/);
    const multi = s(renderField(f("channels"), ["phone"]));
    expect(multi).toContain("<fieldset");
    expect(multi).toMatch(/value="phone" checked/);
    expect(s(renderField(f("tags"), ["a", "b"]))).toContain('value="a, b"');
    expect(s(renderField(f("company"), "c1", { relationTitle: "Acme" }))).toContain('data-relation="/api/companies"');
    expect(s(renderField(f("meta"), { a: 1 }))).toContain("&quot;a&quot;: 1");
    expect(s(renderField(f("owner"), "u2", { members: [{ id: "u1", label: "ann@x.io" }, { id: "u2", label: "bob@x.io" }] }))).toMatch(/<option value="u2" selected>bob@x.io/);
    expect(s(renderField(f("avatar"), "k/a.png", { files: true }))).toContain('type="file"');
  });

  test("rich text: editor content is the engine-sanitized HTML; the textarea keeps the source", () => {
    const h = s(renderField(f("notes"), `<p onclick="x()">Hi <script>alert(1)</script><a href="javascript:alert(1)">x</a></p>`));
    expect(h).toContain('data-richtext="f-notes"');
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).not.toContain("onclick");
    expect(h).not.toContain('href="javascript');
  });
});

describe("display values", () => {
  test("money, percent, booleans, options (label + color class), lists, links", () => {
    expect(s(displayValue(f("value"), 123456))).toBe("$1,234.56");
    expect(s(displayValue(f("chance"), 12.5))).toBe("12.5%");
    expect(s(displayValue(f("vip"), true))).toBe("Yes");
    expect(s(displayValue(f("stage"), "lead"))).toBe('<span class="badge c-blue">Lead</span>');
    expect(s(displayValue(f("stage"), "lost"))).toContain('<span class="badge">Lost &quot;&gt;&lt;script&gt;');
    expect(s(displayValue(f("tags"), ["a", "<b>"]))).toBe('<span class="chip">a</span> <span class="chip">&lt;b&gt;</span>');
    expect(s(displayValue(f("site"), "https://x.io/a?b=1"))).toBe('<a href="https://x.io/a?b=1" rel="noopener noreferrer nofollow">https://x.io/a?b=1</a>');
    expect(s(displayValue(f("site"), "javascript:alert(1)"))).toBe("javascript:alert(1)");
    expect(s(displayValue(f("lastSeen"), "2026-03-01T09:30:00.000Z"))).toBe("2026-03-01 09:30 UTC");
    expect(s(displayValue(f("notes"), "<p>a &amp; <script>x</script><b>b</b></p>"))).toBe("a &amp; b");
    expect(s(displayValue(f("name"), null))).toBe('<span class="muted">—</span>');
  });
});
