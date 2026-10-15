import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/index.ts";

describe("parseDuration", () => {
  test("short units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("10s")).toBe(10_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
  });

  test("long units, spaces and decimals", () => {
    expect(parseDuration("1 day")).toBe(86_400_000);
    expect(parseDuration("3 days")).toBe(3 * 86_400_000);
    expect(parseDuration("2 hours")).toBe(7_200_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("5 minutes")).toBe(300_000);
  });

  test("numbers are milliseconds", () => {
    expect(parseDuration(1500)).toBe(1500);
  });

  test("garbage throws MIU_E_WORKFLOW_DURATION with a fix", () => {
    for (const bad of ["", "soon", "1y", "-1d", "1 dayz", Number.NaN, -5]) {
      let err: any;
      try {
        parseDuration(bad as any);
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("MIU_E_WORKFLOW_DURATION");
      expect(err.fix).toContain('"1d"');
    }
  });
});
