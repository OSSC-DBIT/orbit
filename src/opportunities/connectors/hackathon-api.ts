import { httpJson } from "../../core/http.js";
import { SHARED_RATE_LIMITS, type SourceConnector } from "./base.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { parseIsoDate } from "../normalization/dates.js";
import { canonicalizeUrl } from "../normalization/url.js";

/**
 * Hackathon API connector (https://github.com/0xarchit/hackathon-api, MIT).
 *
 * Access method: read-only calls to a serverless API that already aggregates
 * and deduplicates India-focused hackathons from Devfolio, Unstop, Devpost,
 * MLH, HackerEarth, Hack2Skill, ReSkill, WhereUElevate and Devnovate.
 *
 * Endpoint: GET {baseUrl}/api/v1/hackathons
 *   Optional query params: `platform` (comma separated) and `mode`
 *   (`online` | `offline`). We deliberately call it bare (all platforms),
 *   once per run, at most a few times per hour; the API itself caches for
 *   15 minutes per scrape cycle.
 *
 * Verified live response shape (Oct 2026):
 * {
 *   "status": "success",
 *   "count": 45,
 *   "platform_counts": { "devfolio": 16, "devnovate": 11, ... },
 *   "generated_at": "2026-10-20T09:08:35Z",
 *   "data": [ {
 *     "id": "devpost-31054",            // "<platform>-<sourceId>"
 *     "title": "Qloo Agentic Hackathon",
 *     "platform": "devpost",
 *     "mode": "online" | "offline",
 *     "country": "India",
 *     "location": "Online" | "TBA",
 *     "start_date": "2026-09-30",       // "YYYY-MM-DD" or null
 *     "end_date": "2026-10-30",         // "YYYY-MM-DD" or null
 *     "registration_end": null,         // "YYYY-MM-DD" or null
 *     "url": "https://qloo.devpost.com/",
 *     "prize_pool": "...",              // optional
 *     "tags": ["..."]                   // optional
 *   } ]
 * }
 *
 * Field handling discipline:
 *  - The API has already removed expired events; we STILL validate every date
 *    ourselves and drop anything verifiably in the past.
 *  - Unknown dates stay null; we never invent a deadline from "TBA".
 *  - The upstream project is MIT licensed; attribution is recorded in
 *    embeds ("via 0xarchit/hackathon-api") and in metadata.
 */
const SOURCE_ID = "hackathon-api";

interface AggregateHackathon {
  id: string;
  title: string;
  platform: string;
  mode: string;
  location: string;
  country: string;
  start_date: string | null;
  end_date: string | null;
  registration_end: string | null;
  url: string;
  prize_pool?: string | null;
  tags?: string[] | null;
}

interface AggregateResponse {
  status?: string;
  count?: number;
  platform_counts?: Record<string, number>;
  generated_at?: string;
  data?: AggregateHackathon[];
}

export interface HackathonApiConfig {
  /** Override to self-host the aggregator instead of the community deploy. */
  baseUrl?: string;
}

export class HackathonApiConnector implements SourceConnector {
  readonly sourceId = SOURCE_ID;
  readonly kind = "api" as const;
  readonly categories = ["hackathon", "buildathon", "innovation_challenge"];

  private baseUrl: string;

  constructor(config: HackathonApiConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://hackathon-api-sigma.vercel.app").replace(/\/+$/, "");
  }

  async fetch(): Promise<ConnectorRunResult> {
    const url = `${this.baseUrl}/api/v1/hackathons`;
    const json = await httpJson<AggregateResponse>(url, {
      rateLimit: SHARED_RATE_LIMITS.hackathonApi,
      timeoutMs: 45_000,
      retries: 2,
      headers: { accept: "application/json" },
    });
    if (json.status && json.status !== "success") {
      throw new Error(`hackathon-api reported status ${json.status}`);
    }
    const items = json.data ?? [];
    const records: NormalizedOpportunity[] = [];
    const now = new Date();

    for (const item of items) {
      if (!item.id || !item.title || !item.url) continue;

      const startsAt = parseIsoDate(item.start_date);
      const endsAt = endOfDayUtc(parseIsoDate(item.end_date));
      const registrationEnd = endOfDayUtc(parseIsoDate(item.registration_end));

      // Drop listings the source itself may have missed aging out.
      const eventEnded =
        endsAt !== null && endsAt.getTime() < now.getTime() - 24 * 3600 * 1000;
      const registrationEnded =
        registrationEnd !== null && registrationEnd.getTime() + 24 * 3600 * 1000 < now.getTime();
      if (endedAll(eventEnded, registrationEnded, startsAt, endsAt)) continue;

      const appUrl = canonicalizeUrl(item.url);
      if (!appUrl) continue;

      records.push({
        sourceId: SOURCE_ID,
        externalId: item.id,
        title: item.title.trim().slice(0, 290),
        organization: null,
        category: classifyHackathonItem(item),
        description: buildDescription(item),
        descriptionHtml: null,
        applicationUrl: appUrl,
        sourceUrl: appUrl,
        location: normalizeLocation(item.location),
        remoteStatus: /online/i.test(item.mode) || /online/i.test(item.location ?? "") ? "remote" : "onsite",
        requiredSkills: (item.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 10),
        eligibility: null,
        compensation: parsePrizePool(item.prize_pool ?? null),
        opensAt: null,
        applicationDeadline: registrationEnd,
        eventStartsAt: startsAt,
        eventEndsAt: endsAt,
        sourcePublishedAt: parseIsoDate(json.generated_at ?? null),
        sourceUpdatedAt: parseIsoDate(json.generated_at ?? null),
        metadata: {
          attribution: "via 0xarchit/hackathon-api (MIT)",
          upstreamPlatform: item.platform,
          upstreamCountry: item.country ?? null,
          upstreamMode: item.mode ?? null,
          platformCounts: undefined,
        },
        tags: [
          "hackathon",
          item.platform.toLowerCase(),
          ...((item.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 6)),
        ],
      });
    }

    return { sourceId: SOURCE_ID, records };
  }
}

function endedAll(eventEnded: boolean, registrationEnded: boolean, startsAt: Date | null, endsAt: Date | null): boolean {
  if (registrationEnded) return true;
  if (eventEnded) return true;
  // Events with no dates at all and never started cannot be verified as open.
  return !startsAt && !endsAt && !registrationEnded;
}

function classifyHackathonItem(item: AggregateHackathon): NormalizedOpportunity["category"] {
  const text = `${item.title} ${item.location ?? ""}`.toLowerCase();
  if (/hiring|recruit|intern(?!ship)? challenge|placement/.test(text)) return "internship";
  return "hackathon";
}

function buildDescription(item: AggregateHackathon): string | null {
  const parts: string[] = [];
  if (item.location && item.location !== "TBA") parts.push(`Location: ${item.location}.`);
  if (item.prize_pool) parts.push(`Prize pool: ${item.prize_pool}.`);
  parts.push(`Hosted on ${item.platform}. See the event page for the full brief.`);
  return parts.join(" ").slice(0, 1500);
}

function normalizeLocation(location: string | null): string | null {
  if (!location) return null;
  if (/^tba$/i.test(location)) return null; // TBA == unknown, never shown as data
  return location.trim();
}

function parsePrizePool(raw: string | null): NormalizedOpportunity["compensation"] {
  if (!raw) return null;
  const digits = raw.replace(/[^\d.]/g, "");
  const amount = digits ? Number(digits) : NaN;
  const currency = /₹|inr/i.test(raw) ? "INR" : /$|\$/i.test(raw) ? "USD" : null;
  if (Number.isFinite(amount) && amount > 0) {
    return { amountMin: null, amountMax: amount, currency, note: null };
  }
  return { amountMin: null, amountMax: null, currency: null, note: raw.slice(0, 200) };
}

function endOfDayUtc(d: Date | null): Date | null {
  if (!d) return null;
  const e = new Date(d.getTime());
  e.setUTCHours(23, 59, 59, 0);
  return e;
}
