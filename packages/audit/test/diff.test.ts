import { describe, expect, test } from "bun:test";
import { canonicalJson, diff, redact, redactor, REDACTED } from "../src/index.ts";

describe("canonicalJson", () => {
  test("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  test("arrays keep order; undefined in arrays becomes null; dates use toJSON; bigint as string", () => {
    expect(canonicalJson([undefined, 2, 1])).toBe("[null,2,1]");
    expect(canonicalJson({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
    expect(canonicalJson({ n: 10n })).toBe('{"n":"10"}');
    expect(canonicalJson(null)).toBe("null");
  });
  test("is stable across key insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe("diff", () => {
  test("keeps only changed fields", () => {
    expect(diff({ name: "Ann", email: "a@x", age: 30 }, { name: "Ann", email: "b@x", age: 31 })).toEqual({
      email: { before: "a@x", after: "b@x" },
      age: { before: 30, after: 31 },
    });
  });
  test("added and removed fields", () => {
    expect(diff({ a: 1 }, { b: 2 })).toEqual({ a: { before: 1 }, b: { after: 2 } });
  });
  test("deep values compare by content, not identity", () => {
    expect(diff({ tags: ["x"], addr: { city: "A" } }, { tags: ["x"], addr: { city: "A" } })).toEqual({});
    expect(diff({ addr: { city: "A" } }, { addr: { city: "B" } })).toEqual({ addr: { before: { city: "A" }, after: { city: "B" } } });
  });
  test("create (no before) and delete (no after)", () => {
    expect(diff(undefined, { a: 1 })).toEqual({ a: { after: 1 } });
    expect(diff({ a: 1 }, undefined)).toEqual({ a: { before: 1 } });
  });
  test("non-object values diff as `value`", () => {
    expect(diff(1, 2)).toEqual({ value: { before: 1, after: 2 } });
  });
});

describe("redact", () => {
  const r = redactor();
  test("redacts common secret keys recursively, case- and style-insensitively", () => {
    const input = {
      password: "p",
      newPassword: "p",
      password_hash: "h",
      accessToken: "t",
      refresh_token: "t",
      api_key: "k",
      apiKey: "k",
      "x-api-key": "k",
      Authorization: "Bearer x",
      clientSecret: "s",
      ssn: "123-45-6789",
      patientSSN: "123",
      creditCardNumber: "4111",
      cvv: "123",
      cookie: "sid=1",
      privateKey: "pk",
      nested: { deeper: [{ token: "t", ok: 1 }], name: "Ann" },
    };
    const out = redact(input, r) as any;
    for (const k of Object.keys(input)) if (k !== "nested") expect(out[k]).toBe(REDACTED);
    expect(out.nested).toEqual({ deeper: [{ token: REDACTED, ok: 1 }], name: "Ann" });
  });
  test("does not over-redact look-alike keys", () => {
    const input = { classname: "x", name: "Ann", email: "a@x", assessment: "ok", description: "d", passenger: "p" };
    expect(redact(input, r)).toEqual(input);
  });
  test("custom strings and regexes add to the defaults", () => {
    const custom = redactor(["diagnosis", /^mrn$/i]);
    expect(redact({ diagnosis: "flu", MRN: "1", password: "p", ok: 1 }, custom)).toEqual({ diagnosis: REDACTED, MRN: REDACTED, password: REDACTED, ok: 1 });
  });
  test("global regexes behave the same on every key (no lastIndex drift)", () => {
    const g = redactor([/dob/g]);
    expect(redact({ dob: 1, patient_dob: 2, x: { dob: 3 } }, g)).toEqual({ dob: REDACTED, patient_dob: REDACTED, x: { dob: REDACTED } });
  });
  test("does not mutate its input", () => {
    const input = { password: "p", n: { token: "t" } };
    redact(input, r);
    expect(input).toEqual({ password: "p", n: { token: "t" } });
  });
  test("survives cycles", () => {
    const a: any = { x: 1 };
    a.self = a;
    expect(() => redact(a, r)).not.toThrow();
  });
});
