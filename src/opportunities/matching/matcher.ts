import type { NormalizedOpportunity, StoredOpportunity } from "../../core/types/opportunity.js";
import type { GuildPreferencesRow } from "../../tenants/services/tenant-service.js";

/**
 * Deterministic tenant matching. Runs BEFORE any AI enrichment — cheap first.
 * AI may re-rank within already-matched listings but never overrides these.
 */

export interface MatchReport {
  matched: boolean;
  reasons: string[];
  excludedBy?: string;
}

export function matchesTenantFilters(
  opp: NormalizedOpportunity | StoredOpportunity,
  prefs: GuildPreferencesRow,
): MatchReport {
  const reasons: string[] = [];
  const searchText = [
    opp.title,
    opp.description ?? "",
    ...opp.requiredSkills,
  ].join(" \n").toLowerCase();
  const category = opp.category;
  const allowedSources = prefs.allowedSources.filter(Boolean);
  const blockedSources = prefs.blockedSources.filter(Boolean);

  // ── hard exclusions first ──────────────────────────────────────────────────
  if (blockedSources.includes(opp.sourceId)) {
    return { matched: false, reasons, excludedBy: "blocked-source" };
  }
  if (prefs.enabledCategories.length > 0 && !prefs.enabledCategories.includes(category)) {
    return { matched: false, reasons, excludedBy: "category" };
  }
  for (const bad of prefs.excludeKeywords) {
    if (bad && searchText.includes(bad.toLowerCase())) {
      return { matched: false, reasons, excludedBy: `exclude:${bad}` };
    }
  }
  if (prefs.remoteOnly && opp.remoteStatus !== "remote") {
    return { matched: false, reasons, excludedBy: "remote-only" };
  }
  if (prefs.paidOnly && !(opp.compensation?.amountMax || opp.compensation?.amountMin)) {
    return { matched: false, reasons, excludedBy: "paid-only" };
  }
  if (prefs.studentsOnly && !/student|scholar|university|college|campus|academic/i.test(searchText)) {
    return { matched: false, reasons, excludedBy: "students-only" };
  }
  if (prefs.minCompensation && prefs.minCompensation > 0) {
    const amount = opp.compensation?.amountMax ?? opp.compensation?.amountMin ?? null;
    if (amount === null || amount < prefs.minCompensation) {
      return { matched: false, reasons, excludedBy: "min-compensation" };
    }
  }
  if (prefs.minConfidence > 0 && "confidence" in opp && typeof (opp as StoredOpportunity).confidence === "number") {
    const confidence = (opp as StoredOpportunity).confidence ?? 0;
    if (confidence < prefs.minConfidence / 100) {
      return { matched: false, reasons, excludedBy: "confidence" };
    }
  }

  // ── soft filters ────────────────────────────────────────────────────────────
  if (allowedSources.length > 0 && !allowedSources.includes(opp.sourceId)) {
    return { matched: false, reasons, excludedBy: "not-in-allowlist" };
  }
  if (prefs.includeKeywords.length > 0) {
    const hits = prefs.includeKeywords.filter((k) => k && searchText.includes(k.toLowerCase()));
    if (hits.length === 0) return { matched: false, reasons, excludedBy: "include-keywords" };
    reasons.push(`keywords:${hits.join(",")}`);
  }
  if (prefs.requiredSkills.length > 0) {
    const hits = prefs.requiredSkills.filter((s) => searchText.includes(s.toLowerCase()));
    if (hits.length === 0) return { matched: false, reasons, excludedBy: "required-skills" };
    reasons.push(`skills:${hits.slice(0, 3).join(",")}`);
  }
  if (prefs.locations.length > 0) {
    const locationText = `${opp.location ?? ""} ${searchText}`.toLowerCase();
    const hits = prefs.locations.filter((loc) => locationText.includes(loc.toLowerCase()));
    if (!hits.length && opp.remoteStatus !== "remote") {
      return { matched: false, reasons, excludedBy: "location" };
    }
    reasons.push(`location:${hits.join(",")}`);
  }

  reasons.push("default-accept");
  return { matched: true, reasons };
}

/** Order respects: deadlines first (soonest), then newest publication. */
export function rankOpportunities<T extends { applicationDeadline?: Date | null; sourcePublishedAt?: Date | null; eventStartsAt?: Date | null }>(
  items: T[],
): T[] {
  const withDeadline = items.filter((i) => i.applicationDeadline);
  const withDeadlineSorted = withDeadline.sort(
    (a, b) => (a.applicationDeadline?.getTime() ?? Infinity) - (b.applicationDeadline?.getTime() ?? Infinity),
  );
  const withEvent = items.filter((i) => !i.applicationDeadline && i.eventStartsAt).sort(
    (a, b) => (a.eventStartsAt?.getTime() ?? Infinity) - (b.eventStartsAt?.getTime() ?? Infinity),
  );
  const rest = items
    .filter((i) => !i.applicationDeadline && !i.eventStartsAt)
    .sort((a, b) => (b.sourcePublishedAt?.getTime() ?? 0) - (a.sourcePublishedAt?.getTime() ?? 0));
  return [...withDeadlineSorted, ...withEvent, ...rest];
}
