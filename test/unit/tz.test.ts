import { describe, expect, it } from "vitest";
import { formatInTz, formatDateInTz, hourOfDayInTz, isTz, DEFAULT_TIMEZONE } from "../../src/core/time/tz.js";

describe("timezone helpers (IST first)", () => {
  it("defaults to Asia/Kolkata for IST-first deployments", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Kolkata");
  });

  it("recognizes valid and invalid IANA zones", () => {
    expect(isTz("Asia/Kolkata")).toBe(true);
    expect(isTz("UTC")).toBe(true);
    expect(isTz("Not/AZone")).toBe(false);
  });

  it("formats UTC noon as 17:30 IST the same day", () => {
    const noonUtc = new Date("2026-10-20T12:00:00Z");
    const formatted = formatInTz(noonUtc, "Asia/Kolkata");
    expect(formatted.startsWith("20 Oct 2026, 17:30")).toBe(true);
  });

  it("rolls the calendar day correctly across the IST offset (+5:30)", () => {
    // 2026-10-20T18:30:00Z is midnight IST on Oct 21
    expect(formatInTz(new Date("2026-10-20T18:30:00Z"), "Asia/Kolkata").startsWith("21 Oct 2026, 00:00")).toBe(true);
  });

  it("falls back to UTC for unknown timezone names instead of throwing", () => {
    const formatted = formatInTz(new Date("2026-10-20T12:00:00Z"), "Mars/Olympus");
    expect(formatted.startsWith("20 Oct 2026, 12:00")).toBe(true);
  });

  it("formats date-only values in the tenant zone", () => {
    expect(formatDateInTz(new Date("2026-10-20T12:00:00Z"), "Asia/Kolkata")).toBe("20 Oct 2026");
  });

  it("computes local hour of day for digest scheduling", () => {
    expect(hourOfDayInTz(new Date("2026-10-20T03:30:00Z"), "Asia/Kolkata")).toBe(9); // 09:00 IST
    expect(hourOfDayInTz(new Date("2026-10-20T18:30:00Z"), "Asia/Kolkata")).toBe(0); // 00:00 IST next day
    expect(hourOfDayInTz(new Date("2026-10-20T09:30:00Z"), "UTC")).toBe(9);
    expect(hourOfDayInTz(new Date("2026-10-20T09:30:00Z"), "Not/AZone")).toBe(9); // UTC fallback
  });
});
