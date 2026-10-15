// Which settings and action-input fields are secrets: decided by the schema, never by the name alone.
import { describe, expect, test } from "bun:test";
import { t } from "miujs";
import { isSecretField, redactBySchema } from "../src/system-redact.ts";

const R = "[REDACTED]";

describe("isSecretField", () => {
  test("numbers, booleans and enums are never secrets, whatever their name", () => {
    expect(isSecretField("minPasswordLength", t.integer().json)).toBe(false);
    expect(isSecretField("maxTokens", t.number().json)).toBe(false);
    expect(isSecretField("tokenTtl", t.integer().json)).toBe(false);
    expect(isSecretField("passwordRequired", t.boolean().json)).toBe(false);
    expect(isSecretField("tokenMode", t.enum(["jwt", "opaque"]).json)).toBe(false);
    expect(isSecretField("secret", t.literal("x").json)).toBe(false);
    expect(isSecretField("apiKey", t.nullable(t.integer()).json)).toBe(false);
    expect(isSecretField("tokenExpiresAt", t.date().json)).toBe(false);
  });

  test("strings with a secret-looking name are secrets (also optional and nullable ones)", () => {
    expect(isSecretField("apiKey", t.string().json)).toBe(true);
    expect(isSecretField("password", t.string({ minLength: 8 }).json)).toBe(true);
    expect(isSecretField("sessionSecret", t.string().json)).toBe(true);
    expect(isSecretField("apiToken", t.optional(t.string()).json)).toBe(true);
    expect(isSecretField("webhookSecret", t.nullable(t.string()).json)).toBe(true);
    expect(isSecretField("signingKey", t.string().json)).toBe(true);
    expect(isSecretField("key", t.string().json)).toBe(true);
    expect(isSecretField("private_key", t.string().json)).toBe(true);
    expect(isSecretField("keyPrefix", t.string().json)).toBe(false);
    expect(isSecretField("monkey", t.string().json)).toBe(false);
    expect(isSecretField("name", t.string().json)).toBe(false);
  });

  test("a schema can opt a string in explicitly: format password, writeOnly or x-secret", () => {
    expect(isSecretField("dsn", { type: "string", format: "password" })).toBe(true);
    expect(isSecretField("dsn", { type: "string", writeOnly: true })).toBe(true);
    expect(isSecretField("dsn", { type: "string", "x-secret": true })).toBe(true);
    expect(isSecretField("dsn", { anyOf: [{ type: "string", format: "password" }, { type: "null" }] })).toBe(true);
    expect(isSecretField("dsn", t.string().json)).toBe(false);
  });

  test("without a schema, only string values with a secret-looking name", () => {
    expect(isSecretField("password", undefined, "x")).toBe(true);
    expect(isSecretField("minPasswordLength", undefined, 8)).toBe(false);
    expect(isSecretField("name", undefined, "x")).toBe(false);
  });
});

describe("redactBySchema", () => {
  const schema = t.object({
    minPasswordLength: t.integer(),
    maxTokens: t.integer(),
    apiKey: t.optional(t.string()),
    smtp: t.object({ host: t.string(), password: t.string(), port: t.integer() }),
    hooks: t.array(t.object({ url: t.string(), secret: t.string() })),
  }).json;

  test("replaces secret values with [REDACTED], recursing into objects and arrays", () => {
    const v = { minPasswordLength: 8, maxTokens: 4096, apiKey: "sk-1", smtp: { host: "h", password: "pw", port: 25 }, hooks: [{ url: "u", secret: "s" }] };
    expect(redactBySchema(v, schema)).toEqual({ minPasswordLength: 8, maxTokens: 4096, apiKey: R, smtp: { host: "h", password: R, port: 25 }, hooks: [{ url: "u", secret: R }] });
    expect(v.apiKey).toBe("sk-1");
  });

  test("keys outside the schema fall back to the name rule for strings only; null and scalars pass through", () => {
    expect(redactBySchema({ token: "t", tokenCount: 3, extra: { password: "p" } }, t.object({}).json)).toEqual({ token: R, tokenCount: 3, extra: { password: R } });
    expect(redactBySchema({ token: "t" }, null)).toEqual({ token: R });
    expect(redactBySchema(null, schema)).toBe(null);
    expect(redactBySchema(5, schema)).toBe(5);
  });

  test("record schemas use additionalProperties for every key", () => {
    expect(redactBySchema({ a: "x" }, t.record(t.string({ maxLength: 9 })).json)).toEqual({ a: "x" });
    expect(redactBySchema({ a: "x" }, { type: "object", additionalProperties: { type: "string", format: "password" } })).toEqual({ a: R });
  });
});
