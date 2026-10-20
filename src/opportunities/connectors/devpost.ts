import { httpJson } from "../../core/http.js";
import { SHARED_RATE_LIMITS, type SourceConnector } from "./base.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { parseHumanRange } from "../normalization/dates.js";
import { canonicalizeUrl } from "../normalization/url.js";

/**
 * Devpost connector.
 *
 * Access method: public JSON listing endpoint·
 *   https://devpost.com/api/hackathons?limit=10&page=N
 * (verified 200 OK; structured data: title, org, dates, prizes, themes, URL).
 *
 * Terms: Devpost ships no official public API documentation for this path.
 * We treat it as a conservative read-only integration: low request rate,
 * small page size, no scraping of HTML pages, and a clear back-off. If the
 * endpoint changes, the collector records a failure and skips the source —
 * nothing is fabricated.
 */
const SOURCE_ID = "devpost";
const PAGE_LIMIT = "&limit=24";

interface DevpostListing {
  id: number;
  title: string;
  organization_name?: string | null;
  displayed_location?: { location?: string | null } | null;
  open_state?: string | null;
  url?: string | null;
  submission_period_dates?: string | null;
  prize_amount?: string | null;
  themes?: Array<{ name: string } | null> | null;
  winners_announced?: boolean | null;
  registrations_count?: number | null;
}

interface DevpostResponse {
  hackathons?: DevpostListing[];
  meta?: { total_count?: number } | null;
}

export class DevpostConnector implements SourceConnector {
  readonly sourceId = SOURCE_ID;
  readonly kind = "api" as const;
  readonly categories = ["hackathon", "buildathon", "innovation_challenge"];

  async fetch(options?: { page?: number }): Promise<ConnectorRunResult> {
    const page = options?.page ?? 1;
    const json = await httpJson<DevpostResponse>(
      `https://devpost.com/api/hackathons?${PAGE_LIMIT.replace(/^&/, "")}&page=${page}`,
      { rateLimit: SHARED_RATE_LIMITS.devpost, timeoutMs: 20_000, retries: 2 },
    );
    const listings = json.hackathons ?? [];
    const records: NormalizedOpportunity[] = [];

    for (const listing of listings) {
      if (!listing.id || !listing.title) continue;

      const rawRange = listing.submission_period_dates ?? null;
      const range = parseHumanRange(rawRange);
      const prizeRaw = listing.prize_amount
        ?.replace(/\$\u003cspan[^>]*\u003e/, "$")
        ?.replace(/\u003c\/span\u003e$/, "")
        .replace(/<[^>]+>/g, "");
      const prize = parsePrize(prizeRaw ?? null);
      const location = listing.displayed_location?.location ?? null;
      const descriptionParts: string[] = [];
      if (location) descriptionParts.push(`Location: ${location}.`);
      if (prize?.note) descriptionParts.push(`Prizes: ${prize.note}.`);
      else if (prize?.amountMax) {
        descriptionParts.push(`Prizes: up to ${prize.currency ?? ""}${prize.amountMax.toLocaleString()}.`);
      }
      descriptionParts.push("See the listing page for the full brief.");

      records.push({
        sourceId: SOURCE_ID,
        externalId: String(listing.id),
        title: listing.title.trim(),
        organization: listing.organization_name || null,
        category: "hackathon",
        description: descriptionParts.join(" ").slice(0, 2000),
        descriptionHtml: null,
        applicationUrl: canonicalizeUrl(listing.url) ?? null,
        sourceUrl: canonicalizeUrl(listing.url) ?? null,
        location,
        remoteStatus: /online|virtual|remote/i.test(location ?? "") ? "remote" : location ? "onsite" : null,
        requiredSkills: (listing.themes ?? [])
          .filter((t): t is { name: string } => !!t?.name)
          .map((t) => t.name.toLowerCase()),
        eligibility: null,
        compensation: prize,
        opensAt: null,
        applicationDeadline: range.endsAt,
        eventStartsAt: range.startsAt,
        eventEndsAt: range.endsAt,
        sourcePublishedAt: null,
        sourceUpdatedAt: new Date(),
        metadata: {
          registrationsCount: listing.registrations_count ?? null,
          openState: listing.open_state ?? null,
          prizeNote: prize?.note ?? null,
        },
        tags: (listing.themes ?? [])
          .filter((t): t is { name: string } => !!t?.name)
          .map((t) => t.name.toLowerCase()),
      });
    }

    // If the source reported fewer than a page worth and meta shows no more,
    // nothing else to do — removal old IDs is handled by the collector sweep.
    return {
      sourceId: SOURCE_ID,
      records,
    };
  }
}

function parsePrize(raw: string | null): NormalizedOpportunity["compensation"] {
  if (!raw) return null;
  const digits = raw.replace(/[^\d.]/g, "");
  const amount = digits ? Number(digits) : NaN;
  const currency = raw.trim().startsWith("$") ? "USD" : null;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { amountMin: null, amountMax: null, currency: null, note: raw.slice(0, 200) };
  }
  return {
    amountMin: null,
    amountMax: amount,
    currency,
    note: null,
  };
}
