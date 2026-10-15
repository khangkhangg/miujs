import { afterEach, expect, test } from "bun:test";
import { db } from "../src/index.ts";

afterEach(() => {
  delete process.env.MIU_TARGET;
});

test("plain db() declares nothing when not targeting Cloudflare", () => {
  expect(db().cloudflare?.()).toEqual({});
});

test("plain db() declares the DB D1 binding when MIU_TARGET=cloudflare", () => {
  process.env.MIU_TARGET = "cloudflare";
  expect(db().cloudflare?.()).toEqual({ d1: ["DB"] });
});
