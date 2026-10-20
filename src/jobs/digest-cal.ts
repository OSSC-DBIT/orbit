import { hourOfDayInTz } from "../core/time/tz.js";

/** Hour-of-day in a tenant timezone (rounded to whole hours). */
export function hoursOfDigest(date: Date, timeZone: string): number {
  return hourOfDayInTz(date, timeZone || "Asia/Kolkata");
}

/** Digest uniqueness key per tenant-day in local time. */
export function digestDayKey(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return `${timeZone}:${fmt.format(date)}`;
}
