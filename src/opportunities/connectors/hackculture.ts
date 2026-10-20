import { httpJson } from "../../core/http.js";
import { SHARED_RATE_LIMITS, type SourceConnector } from "./base.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { parseIsoDate } from "../normalization/dates.js";
import { canonicalizeUrl } from "../normalization/url.js";

/**
 * HackCulture connector (hackculture.io, Indian program platform: hackathons,
 * innovation challenges, startup challenges).
 *
 * Access method: the site's own public read API used by its SPA
 *   GET https://api.hackculture.io/api/v1/hackathons
 *       ?response_type=card&limit=50&skip=<offset>
 * Verified live (Oct 2026). Pagination uses `skip` (offset) paging until the
 * response array is shorter than the page size; `page=` is NOT supported.
 *
 * Privacy/terms: only published public program cards are read; no auth is
 * bypassed (the admin endpoints /api/v1/hackathons/all etc. require an
 * authenticated session and are never touched). Rate kept low and cached by
 * Orbit. Attribution "via HackCulture" is stored on every record.
 *
 * Verified card shape:
 * {
 *   "_id": "68f9f4a86bc62122eb4f4656",
 *   "name": "VTION INNOVATE HACKATHON",
 *   "tagline": "Join OTT Hackathon, where elite builders ...",
 *   "type": "hackathon" | "startup_challenge" | "innovation_challenge",
 *   "industry": "technology",
 *   "min_team_size": 1, "max_team_size": 4,
 *   "mode": "online" | "offline" | "hybrid",
 *   "status": "published",
 *   "is_completed": false,
 *   "location": { "name": "Bengaluru", "address": "...", "coordinates": [..] } | null,
 *   "start_datetime": "2024-07-11T03:24:00Z",
 *   "end_datetime": "2024-08-30T09:25:00Z",
 *   "slug": "vtion-innovate-hackathon",
 *   "organizer_name": "HackCulture",
 *   "tags": ["..."] | [{ "name": "is_featured", "value": "false" }] | null,
 *   "is_registration_open": true,
 *   "external_registration_url": "https://..." | null
 * }
 *
 * Field discipline:
 *  - deadline: the platform card exposes NO separate registration cutoff
 *    (only is_registration_open and an external URL), so applicationDeadline
 *    stays null even when registration is open. Nothing is invented.
 *  - is_registration_open closed cards are dropped along with anything whose
 *    window ended; freshness is anchored on today's date at sync time.
 */
const SOURCE_ID = "hackculture";
const PAGE_SIZE = 50;
const MAX_PAGES = 3;

interface HcLocation {
  name?: string | null;
  address?: string | null;
}

/**
 * Public card branding block; cover_photo and logo are public Azure blob
 * image URLs the listing page itself renders.
 */
interface HcBranding {
  cover_photo?: string | null;
  logo?: string | null;
}

interface HcCard {
  _id: string;
  name: string;
  tagline?: string | null;
  type?: string | null;
  industry?: string | null;
  min_team_size?: number | null;
  max_team_size?: number | null;
  mode?: string | null;
  status?: string | null;
  is_completed?: boolean | null;
  location?: HcLocation | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
  slug?: string | null;
  organizer_name?: string | null;
  branding?: HcBranding | null;
  /** Live API (re-verified Oct 2026): strings, {name,value} pairs, or null. */
  tags?: Array<string | { name?: unknown; value?: unknown }> | string | null;
  is_registration_open?: boolean | null;
  external_registration_url?: string | null;
}

export interface HackCultureConfig {
  baseUrl?: string;
}

export class HackCultureConnector implements SourceConnector {
  readonly sourceId = SOURCE_ID;
  readonly kind = "api" as const;
  readonly categories = ["hackathon", "innovation_challenge", "buildathon", "internship"];

  private baseUrl: string;

  constructor(config: HackCultureConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://api.hackculture.io").replace(/\/+$/, "");
  }

  async fetch(): Promise<ConnectorRunResult> {
    const now = new Date();
    const nowMs = now.getTime(); // today anchored freshness reference
    const all: HcCard[] = [];

    for (let page = 0, skip = 0; page < MAX_PAGES; page++, skip += PAGE_SIZE) {
      const json = await httpJson<HcCard[] | { data?: HcCard[] }>(
        `${this.baseUrl}/api/v1/hackathons?response_type=card&limit=${PAGE_SIZE}&skip=${skip}`,
        { rateLimit: SHARED_RATE_LIMITS.hackculture, timeoutMs: 20_000, retries: 1 },
      );
      const items = Array.isArray(json) ? json : (json.data ?? []);
      all.push(...items);
      if (items.length < PAGE_SIZE) break;
    }

    const records: NormalizedOpportunity[] = [];

    for (const card of all) {
      if (card.status && card.status !== "published") continue;
      if (card.is_completed === true) continue;
      if (card.is_registration_open === false) continue; // closed = not actionable

      const startsAt = parseIsoDate(card.start_datetime);
      const endsAt = parseIsoDate(card.end_datetime);
      // Today anchored freshness, per AGENTS.md (past or undated hackathons
      // are dropped, never invented): ended anywhere -> dropped; no end date
      // but started before today -> historical; completely undated -> dropped.
      if (!startsAt && !endsAt) continue;
      if (endsAt && endsAt.getTime() < nowMs) continue;
      if (!endsAt && startsAt && startsAt.getTime() < nowMs) continue;
      if (!card.name || !card.slug) continue;

      const appUrl =
        canonicalizeUrl(card.external_registration_url) ??
        canonicalizeUrl(`https://hackculture.io/programs/${card.slug}`);
      if (!appUrl) continue;

      records.push({
        sourceId: SOURCE_ID,
        externalId: card._id ?? card.slug,
        title: card.name.trim().slice(0, 290),
        organization: card.organizer_name || null,
        category: mapType(card.type, card.name, card.tagline ?? ""),
        description: (card.tagline ?? "").slice(0, 1500) || null,
        descriptionHtml: null,
        applicationUrl: appUrl,
        sourceUrl: canonicalizeUrl(`https://hackculture.io/programs/${card.slug}`),
        location: card.location?.name ?? card.location?.address ?? null,
        remoteStatus: /online/i.test(card.mode ?? "") ? "remote" : /hybrid/i.test(card.mode ?? "") ? "hybrid" : card.mode ? "onsite" : null,
        requiredSkills: [],
        eligibility: eligibilityStrings(card),
        compensation: null,
        opensAt: null,
        applicationDeadline: null, // never invented; platform has no card-level deadline
        eventStartsAt: startsAt,
        eventEndsAt: endsAt,
        sourcePublishedAt: null,
        sourceUpdatedAt: now,
        metadata: {
          attribution: "via HackCulture",
          programType: card.type ?? null,
          industry: card.industry ?? null,
          mode: card.mode ?? null,
          teamSize: card.min_team_size && card.max_team_size ? `${card.min_team_size}-${card.max_team_size}` : null,
          isRegistrationOpen: card.is_registration_open ?? null,
          coverImage: canonicalizeUrl(card.branding?.cover_photo ?? null),
        },
        tags: [
          "hackculture",
          ...(typeof card.industry === "string" && card.industry
            ? [card.industry.toLowerCase()].filter(Boolean)
            : []),
          ...tagStrings(card.tags),
        ],
      });
    }

    return { sourceId: SOURCE_ID, records };
  }
}

/**
 * HackCulture tags arrived as plain strings in 2024 models but re-verified
 * live as {name,value} pairs in October 2026 (sometimes null). Only source
 * provided names are kept (strings and object names); unknown shapes never
 * become guesses. Coercion must not throw, or the whole sync fails.
 */
export function tagStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((t) => {
        if (typeof t === "string") return t;
        if (t !== null && typeof t === "object" && typeof (t as { name?: unknown }).name === "string") {
          return (t as { name: string }).name;
        }
        return "";
      })
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  if (typeof raw === "string") return [raw.toLowerCase().trim()].filter(Boolean);
  return [];
}

function mapType(type: string | null | undefined, name: string, tagline: string): NormalizedOpportunity["category"] {
  const text = `${name} ${tagline}`.toLowerCase();
  if (/hiring|recruit|internship/i.test(text)) return "internship";
  if ((type ?? "").toLowerCase() === "startup_challenge") return "innovation_challenge";
  if ((type ?? "").toLowerCase() === "innovation_challenge") return "innovation_challenge";
  return "hackathon";
}

function eligibilityStrings(card: HcCard): string[] | null {
  const out: string[] = [];
  if (card.min_team_size && card.max_team_size) {
    out.push(`Team size: ${card.min_team_size}-${card.max_team_size}`);
  } else if (card.min_team_size) {
    out.push(`Team size: ${card.min_team_size}+`);
  }
  return out.length ? out : null;
}
