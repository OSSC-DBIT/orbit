import { fingerprintOf } from "../../core/ids.js";
import { canonicalizeUrl } from "../normalization/url.js";
import { normalizeTitle, similarityKey } from "../normalization/text.js";
import type { NormalizedOpportunity } from "../../core/types/opportunity.js";

/**
 * Layered deduplication keys.
 *
 * Layer 1: (sourceId, externalId) — exact source identity.
 * Layer 2: canonical application URL.
 * Layer 3: normalized title + organization.
 * Layer 4 (crop): cross-source similarity — only compares within the same
 * category and requires title AND org AND overlapping URL host, so distinct
 * opportunities with similar titles are never merged.
 */

export type DedupStrategy = "source-identity" | "url" | "title-org" | "none";

export function sourceIdentityKey(sourceId: string, externalId: string): string {
  return fingerprintOf(["src", sourceId, externalId]);
}

export function urlKey(appUrl: string | null): string | null {
  const canonical = canonicalizeUrl(appUrl);
  return canonical ? fingerprintOf(["url", canonical]) : null;
}

export function titleOrgKey(title: string, organization: string | null): string {
  return fingerprintOf(["titleorg", similarityKey(title, organization)]);
}

/** The canonical `dedup_key` column value: most specific layer wins. */
export function computeDedupKey(opp: NormalizedOpportunity): {
  dedupKey: string;
  strategy: DedupStrategy;
} {
  const byUrl = urlKey(opp.applicationUrl ?? opp.sourceUrl);
  if (byUrl) return { dedupKey: byUrl, strategy: "url" };
  // Fall back to title+org when a URL is absent.
  const titleKey = titleOrgKey(opp.title, opp.organization);
  if (opp.title.length > 8) return { dedupKey: titleKey, strategy: "title-org" };
  return { dedupKey: sourceIdentityKey(opp.sourceId, opp.externalId), strategy: "source-identity" };
}

/** Fingerprint of meaningful content — change ⇒ announcement-worthy update. */
export function computeContentFingerprint(opp: NormalizedOpportunity): string {
  return fingerprintOf([
    "content",
    opp.title,
    opp.organization ?? "",
    opp.description ?? "",
    opp.applicationUrl ?? "",
    opp.eventStartsAt?.toISOString() ?? "",
    opp.eventEndsAt?.toISOString() ?? "",
    opp.applicationDeadline?.toISOString() ?? "",
    opp.compensation?.amountMin?.toString() ?? "",
    opp.compensation?.amountMax?.toString() ?? "",
  ]);
}

export interface SimilarPair {
  a: NormalizedOpportunity;
  b: NormalizedOpportunity;
}

/**
 * Conservative cross-source duplicate check:
 * same category + similar titles (Jaccard ≥ 0.6 on tokens) + same organization
 * (or one org unknown while URL host matches).
 */
export function areCrossSourceDuplicates(a: NormalizedOpportunity, b: NormalizedOpportunity): boolean {
  if (a.sourceId === b.sourceId) return false; // same source handled by identity/URL keys
  if (a.category !== b.category) return false;
  const ta = tokens(a.title);
  const tb = tokens(b.title);
  if (jaccard(ta, tb) < 0.6) return false;
  const orgMatch =
    (a.organization && b.organization && normalizeTitle(a.organization) === normalizeTitle(b.organization)) ||
    (!a.organization !== !b.organization && hostsOverlap(a.applicationUrl, b.applicationUrl));
  return orgMatch;
}

function hostsOverlap(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter++;
  return inter / (a.size + b.size - inter);
}
