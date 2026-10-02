import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, describeCron } from "../src/watch/cron.js";

// Local-time Date helper (calendar fields are local, matching the matcher).
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe("parseCron", () => {
  it("parses a full expression into value sets", () => {
    const c = parseCron("0 9 1-5 */2 0");
    expect(c).not.toBeNull();
    expect([...c!.minute]).toEqual([0]);
    expect([...c!.hour]).toEqual([9]);
    expect([...c!.dom]).toEqual([1, 2, 3, 4, 5]);
    expect([...c!.month]).toEqual([1, 3, 5, 7, 9, 11]);
    expect([...c!.dow]).toEqual([0]);
  });

  it("supports *, */n, a-b/n, and comma lists", () => {
    expect([...parseCron("* * * * *")!.minute]).toEqual(
      Array.from({ length: 60 }, (_, i) => i),
    );
    expect([...parseCron("*/15 * * * *")!.minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("1-10/3 * * * *")!.minute]).toEqual([1, 4, 7, 10]);
    expect([...parseCron("1,3,5 * * * *")!.minute]).toEqual([1, 3, 5]);
  });

  it("folds dow 7 to 0 (both Sunday)", () => {
    expect([...parseCron("0 0 * * 7")!.dow]).toEqual([0]);
  });

  it("returns null for invalid expressions", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * * *")).toBeNull(); // 4 fields
    expect(parseCron("* * * * * *")).toBeNull(); // 6 fields
    expect(parseCron("60 * * * *")).toBeNull(); // minute out of range
    expect(parseCron("* 24 * * *")).toBeNull(); // hour out of range
    expect(parseCron("* * 0 * *")).toBeNull(); // dom 0 is invalid
    expect(parseCron("* * 32 * *")).toBeNull();
    expect(parseCron("* * * 13 *")).toBeNull();
    expect(parseCron("* * * * 8")).toBeNull();
    expect(parseCron("a * * * *")).toBeNull();
    expect(parseCron("5-1 * * * *")).toBeNull(); // reversed range
    expect(parseCron("*/0 * * * *")).toBeNull(); // zero step
    expect(parseCron("1,,2 * * * *")).toBeNull(); // empty list item
  });
});

describe("cronMatches", () => {
  it("* matches any minute", () => {
    expect(cronMatches("* * * * *", at(2026, 10, 2, 9, 37))).toBe(true);
  });

  it("*/15 matches only those minutes", () => {
    expect(cronMatches("*/15 * * * *", at(2026, 10, 2, 9, 30))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(2026, 10, 2, 9, 31))).toBe(false);
  });

  it("matches fixed hour/minute and ranges", () => {
    expect(cronMatches("30 8 * * *", at(2026, 10, 2, 8, 30))).toBe(true);
    expect(cronMatches("30 8 * * *", at(2026, 10, 2, 9, 30))).toBe(false);
    expect(cronMatches("0 9-17 * * *", at(2026, 10, 2, 13, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at(2026, 10, 2, 18, 0))).toBe(false);
  });

  it("handles comma lists", () => {
    expect(cronMatches("1,3,5 * * * *", at(2026, 10, 2, 0, 3))).toBe(true);
    expect(cronMatches("1,3,5 * * * *", at(2026, 10, 2, 0, 4))).toBe(false);
  });

  it("applies the dom/dow OR rule when BOTH are restricted", () => {
    const expr = "0 0 1 * 1"; // 1st of month OR Monday
    expect(cronMatches(expr, at(2026, 1, 1, 0, 0))).toBe(true); // 1st (Thu)
    expect(cronMatches(expr, at(2026, 1, 5, 0, 0))).toBe(true); // Monday, not 1st
    expect(cronMatches(expr, at(2026, 1, 6, 0, 0))).toBe(false); // Tue, not 1st
  });

  it("requires the restricted field when only ONE of dom/dow is restricted", () => {
    // Only dom restricted -> must be the 1st even on a Monday.
    expect(cronMatches("0 0 1 * *", at(2026, 1, 5, 0, 0))).toBe(false);
    expect(cronMatches("0 0 1 * *", at(2026, 1, 1, 0, 0))).toBe(true);
    // Only dow restricted -> must be Monday even on the 1st.
    expect(cronMatches("0 0 * * 1", at(2026, 1, 1, 0, 0))).toBe(false);
    expect(cronMatches("0 0 * * 1", at(2026, 1, 5, 0, 0))).toBe(true);
  });

  it("returns false for a malformed expression", () => {
    expect(cronMatches("nope", at(2026, 10, 2, 9, 0))).toBe(false);
    expect(cronMatches("99 * * * *", at(2026, 10, 2, 9, 0))).toBe(false);
  });
});

describe("describeCron", () => {
  it("describes the common cases in Chinese", () => {
    expect(describeCron("*/30 * * * *")).toBe("每 30 分钟");
    expect(describeCron("0 9 * * *")).toBe("每天 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("工作日 09:00");
    expect(describeCron("* * * * *")).toBe("每分钟");
    expect(describeCron("0 * * * *")).toBe("每小时");
    expect(describeCron("30 8 * * 1")).toBe("每周一 08:30");
    expect(describeCron("0 9 * * 0,6")).toBe("周末 09:00");
  });

  it("falls back to the raw expression for anything else", () => {
    expect(describeCron("0 9 1 * *")).toBe("0 9 1 * *");
  });
});
