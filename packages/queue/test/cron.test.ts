import { describe, expect, test } from "bun:test";
import { parseCron } from "../src/index.ts";

const at = (iso: string) => new Date(iso + "Z"); // cron matches in UTC, like Cloudflare

describe("parseCron", () => {
  test("* * * * * matches every minute", () => {
    const c = parseCron("* * * * *");
    expect(c.matches(at("2026-01-01T00:00:00"))).toBe(true);
    expect(c.matches(at("2026-07-15T13:47:00"))).toBe(true);
  });

  test("numbers", () => {
    const c = parseCron("30 9 * * *");
    expect(c.matches(at("2026-03-02T09:30:00"))).toBe(true);
    expect(c.matches(at("2026-03-02T09:31:00"))).toBe(false);
    expect(c.matches(at("2026-03-02T10:30:00"))).toBe(false);
  });

  test("steps */n", () => {
    const c = parseCron("*/5 * * * *");
    expect([0, 5, 55].every((m) => c.matches(at(`2026-01-01T00:${String(m).padStart(2, "0")}:00`)))).toBe(true);
    expect(c.matches(at("2026-01-01T00:07:00"))).toBe(false);
  });

  test("ranges, lists and stepped ranges", () => {
    const c = parseCron("0 9-17/2 * * 1-5");
    expect(c.minute).toEqual([0]);
    expect(c.hour).toEqual([9, 11, 13, 15, 17]);
    expect(c.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("1,2,10-12 * * * *").minute).toEqual([1, 2, 10, 11, 12]);
    expect(parseCron("5/20 * * * *").minute).toEqual([5, 25, 45]);
  });

  test("day of week: 7 is Sunday too", () => {
    expect(parseCron("0 0 * * 7").dayOfWeek).toEqual([0]);
    // 2026-03-01 is a Sunday
    expect(parseCron("0 0 * * 0").matches(at("2026-03-01T00:00:00"))).toBe(true);
    expect(parseCron("0 0 * * 0").matches(at("2026-03-02T00:00:00"))).toBe(false);
  });

  test("month and day of month", () => {
    const c = parseCron("0 0 1 1 *");
    expect(c.matches(at("2026-01-01T00:00:00"))).toBe(true);
    expect(c.matches(at("2026-02-01T00:00:00"))).toBe(false);
  });

  test("when both day fields are restricted, either may match (standard cron)", () => {
    const c = parseCron("0 0 13 * 5"); // the 13th, or any Friday
    expect(c.matches(at("2026-03-13T00:00:00"))).toBe(true); // Friday 13th
    expect(c.matches(at("2026-04-13T00:00:00"))).toBe(true); // Monday 13th
    expect(c.matches(at("2026-03-06T00:00:00"))).toBe(true); // a Friday
    expect(c.matches(at("2026-03-07T00:00:00"))).toBe(false);
  });

  test("ignores extra whitespace and keeps the source", () => {
    expect(parseCron("  */5   *  * * * ").source).toBe("*/5 * * * *");
  });

  test.each([
    ["* * * *", "5 fields"],
    ["60 * * * *", "out of range"],
    ["* 24 * * *", "out of range"],
    ["* * 0 * *", "out of range"],
    ["* * * 13 *", "out of range"],
    ["* * * * 8", "out of range"],
    ["*/0 * * * *", "step"],
    ["5-1 * * * *", "range"],
    ["a * * * *", "number"],
    ["1,,2 * * * *", "number"],
  ])("rejects %p", (expr) => {
    try {
      parseCron(expr);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as any).code).toBe("MIU_E_QUEUE_CRON");
      expect((e as any).fix).toBeTruthy();
    }
  });
});
