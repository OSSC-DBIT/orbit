/**
 * Timezone helpers. Orbit stores all instants in UTC; presentation happens in
 * the tenant's IANA timezone (default Asia/Kolkata for IST-first deployments,
 * configurable via DEFAULT_TIMEZONE and per-guild).
 */
export const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE && isTz(process.env.DEFAULT_TIMEZONE)
  ? process.env.DEFAULT_TIMEZONE
  : "Asia/Kolkata";

export function isTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "20 Oct 2026, 14:35 IST" style formatting with tz abbreviation. */
export function formatInTz(date: Date, timeZone = DEFAULT_TIMEZONE): string {
  if (!isTz(timeZone)) timeZone = "UTC";
  const dayMonth = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const tzLabel = shortTzLabel(date, timeZone);
  return `${dayMonth}, ${time} ${tzLabel}`;
}

function shortTzLabel(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "short" }).formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Formats a date-only style value used for event windows (IST aware). */
export function formatDateInTz(date: Date, timeZone = DEFAULT_TIMEZONE): string {
  if (!isTz(timeZone)) timeZone = "UTC";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Current hour-of-day (0..23) in the given timezone. */
export function hourOfDayInTz(date: Date, timeZone = DEFAULT_TIMEZONE): number {
  if (!isTz(timeZone)) timeZone = "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value;
  return hour !== undefined ? Number(hour) : date.getUTCHours();
}
