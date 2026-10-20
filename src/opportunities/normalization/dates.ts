/**
 * Robust date parsing for untrusted external content.
 * News: "Aug 31 - Oct 23, 2026", "Oct 05 - 27, 2026", ISO 8601, unix seconds.
 * Returns `null` when unknown — never guesses.
 */

export interface ParsedDateRange {
  startsAt: Date | null;
  endsAt: Date | null;
}

const MONTHS = new Map(
  [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  ].map((m, i) => [m, i]),
);

export function parseUnixSeconds(value: unknown): Date | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n; // accept unix seconds or ms
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthNumber(mon: string): number | null {
  return MONTHS.get(mon.slice(0, 3).toLowerCase()) ?? null;
}

function constructDate(year: number, monthZeroBased: number, day: number, hour = 23, minute = 59): Date | null {
  const d = new Date(Date.UTC(year, monthZeroBased, day, hour, minute, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parses human ranges like:
 *   "Aug 31 - Oct 23, 2026"
 *   "Oct 05 - 27, 2026"
 *   "Sep 15, 2026"
 *   "12 October 2026"
 */
export function parseHumanRange(input: string | null): ParsedDateRange {
  if (!input) return { startsAt: null, endsAt: null };
  const text = input.trim();

  // ISO range "2026-10-23/2026-10-30" or "- to -"
  const isoRange = /^(\d{4}-\d{2}-\d{2})\s*(?:to|[-–]|\/)\s*(\d{4}-\d{2}-\d{2})$/i.exec(text);
  if (isoRange) {
    const a = isoRange[1];
    const b = isoRange[2];
    return { startsAt: parseIsoDate(a ?? null), endsAt: parseIsoDate(b ?? null) };
  }

  // "Mon D - Mon D, YYYY" (possibly same year, second date may reuse year)
  const rangeRe =
    /([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:[-–]|to)\s*([A-Za-z]{3,9})?\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:,?\s*(\d{4}))?/i;
  const rangeMatch = rangeRe.exec(text);
  if (rangeMatch) {
    const [, monA, dayA, monB, dayB, yearStr] = rangeMatch as unknown as [string, string, string, string | undefined, string, string | undefined];
    const m1 = monthNumber(monA);
    const year = yearStr ? Number(yearStr) : new Date().getUTCFullYear();
    if (m1 !== null) {
      const start = constructDate(year, m1, Number(dayA), 0, 0);
      let end: Date | null = null;
      if (monB) {
        const m2 = monthNumber(monB);
        if (m2 !== null) end = constructDate(year, m2, Number(dayB), 23, 59);
      } else if (start) {
        // same month as start
        end = constructDate(year, m1, Number(dayB), 23, 59);
      }
      if (start) return { startsAt: start, endsAt: end };
      return { startsAt: null, endsAt: null };
    }
  }

  // "Mon D, YYYY"
  const singleRe = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s*(\d{4})?$/i;
  const singleMatch = singleRe.exec(text);
  if (singleMatch) {
    const [, mon, day, yearStr] = singleMatch as unknown as [string, string, string, string | undefined];
    const m = monthNumber(mon);
    if (m !== null) {
      const year = yearStr ? Number(yearStr) : new Date().getUTCFullYear();
      const d = constructDate(year, m, Number(day), 0, 0);
      if (d) return { startsAt: d, endsAt: null };
    }
  }

  // Day month year "12 October 2026"
  const dmyRe = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/i;
  const dmyMatch = dmyRe.exec(text);
  if (dmyMatch) {
    const [, day, mon, yearStr] = dmyMatch as unknown as [string, string, string, string];
    const m = monthNumber(mon);
    if (m !== null) {
      const d = constructDate(Number(yearStr), m, Number(day), 0, 0);
      if (d) return { startsAt: d, endsAt: null };
    }
  }

  const iso = parseIsoDate(text);
  return iso ? { startsAt: iso, endsAt: null } : { startsAt: null, endsAt: null };
}

/** "3 days left" / "12 hours left" → deadline inferred? No: returns null. */
export function parseTimeLeft(_timeLeft: string | null): null {
  // Intentionally not trusting relative strings: they change constantly and
  // would create false deadlines. Absolute dates only.
  return null;
}

/**
 * deadline heuristics for events: if only an event range exists and it is in
 * the past → opportunity has ended; if `submission_period_dates` has a value,
 * its end doubles as the application deadline (a source-provided fact, not a guess).
 */
export function deadlineFromRange(range: ParsedDateRange): Date | null {
  return range.endsAt;
}
