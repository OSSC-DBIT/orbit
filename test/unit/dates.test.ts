import { describe, expect, it } from "vitest";
import {
  parseHumanRange,
  parseIsoDate,
  parseUnixSeconds,
  parseTimeLeft,
  deadlineFromRange,
} from "../../src/opportunities/normalization/dates.js";

describe("date parsing (never guesses)", () => {
  it("parses 'Aug 31 - Oct 23, 2026' as a UTC range", () => {
    const r = parseHumanRange("Aug 31 - Oct 23, 2026");
    expect(r.startsAt?.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(r.endsAt?.toISOString()).toBe("2026-10-23T23:59:00.000Z");
  });

  it("parses same-month ranges 'Oct 05 - 27, 2026'", () => {
    const r = parseHumanRange("Oct 05 - 27, 2026");
    expect(r.startsAt?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(r.endsAt?.toISOString()).toBe("2026-10-27T23:59:00.000Z");
  });

  it("parses single dates 'Sep 15, 2026' and '12 October 2026'", () => {
    expect(parseHumanRange("Sep 15, 2026").startsAt?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(parseHumanRange("12 October 2026").startsAt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("parses ISO ranges '2026-10-23/2026-10-30'", () => {
    const r = parseHumanRange("2026-10-23/2026-10-30");
    expect(r.startsAt?.getUTCFullYear()).toBe(2026);
    expect(r.endsAt?.toISOString().startsWith("2026-10-30")).toBe(true);
  });

  it("returns nulls for garbage or empty input (no invention)", () => {
    expect(parseHumanRange(null)).toEqual({ startsAt: null, endsAt: null });
    expect(parseHumanRange("coming soon")).toEqual({ startsAt: null, endsAt: null });
  });

  it("parses ISO strings and rejects non-strings", () => {
    expect(parseIsoDate("2026-10-20T09:08:35Z")?.getUTCFullYear()).toBe(2026);
    expect(parseIsoDate("nope")).toBeNull();
    expect(parseIsoDate(42)).toBeNull();
  });

  it("parses unix seconds and milliseconds", () => {
    expect(parseUnixSeconds(1790000000)?.getTime()).toBe(1790000000000);
    expect(parseUnixSeconds(1790000000000)?.getTime()).toBe(1790000000000);
    expect(parseUnixSeconds("x")).toBeNull();
  });

  it("never derives deadlines from relative strings", () => {
    expect(parseTimeLeft("3 days left")).toBeNull();
  });

  it("uses the end of the submission window as the deadline fact", () => {
    const r = parseHumanRange("Oct 05 - 27, 2026");
    expect(deadlineFromRange(r)?.toISOString().startsWith("2026-10-27")).toBe(true);
    expect(deadlineFromRange({ startsAt: null, endsAt: null })).toBeNull();
  });
});
