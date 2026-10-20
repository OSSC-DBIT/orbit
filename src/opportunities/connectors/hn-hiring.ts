import { httpJson } from "../../core/http.js";
import { SHARED_RATE_LIMITS, type SourceConnector } from "./base.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { stripHtml } from "../normalization/text.js";
import { parseIsoDate } from "../normalization/dates.js";

/**
 * Hacker News "Who is hiring?" connector.
 *
 * Access method: Algolia's public HN Search API
 *   https://hn.algolia.com/api/v1/search_by_date?tags=ask_hn,story_%3Cid%3E
 * The monthly thread IDs rotate; we resolve the latest "Ask HN: Who is hiring?"
 * story via `search_by_date?query="Ask HN: Who is hiring?"&tags=ask_hn`.
 * Comment text is parsed line-by-line; only structural facts are kept (org,
 * location, remote). HN comment headers follow stable formatting used by the
 * community (company-name line, then description, then "Location:" pairs).
 *
 * Terms: public, rate limiting documented by Algolia (be gentle; we cap).
 */
const SOURCE_ID = "hn-hiring";

interface AlgoliaHit {
  objectID: string;
  title?: string;
  story_comment_count?: number;
  created_at?: string;
}

interface AlgoliaCommentHit extends AlgoliaHit {
  comment_text?: string | null;
  story_id?: number;
  author?: string;
  created_at_i?: number;
}

export class HnHiringConnector implements SourceConnector {
  readonly sourceId = SOURCE_ID;
  readonly kind = "api" as const;
  readonly categories = ["job", "remote_job", "internship"];

  /** Cached latest thread id (refreshed each run). */
  private threadId: string | null = null;

  async fetch(options?: { page?: number }): Promise<ConnectorRunResult> {
    if (!this.threadId) {
      await this.resolveThread();
      if (!this.threadId) return { sourceId: SOURCE_ID, records: [] };
    }
    const page = options?.page ?? 0;
    const json = await httpJson<{ hits: AlgoliaCommentHit[]; nbPages?: number }>(
      `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${this.threadId}&hitsPerPage=100&page=${page}`,
      { rateLimit: SHARED_RATE_LIMITS.hn, timeoutMs: 20_000, retries: 2 },
    );
    const records: NormalizedOpportunity[] = [];

    for (const hit of json.hits ?? []) {
      const text = hit.comment_text;
      if (!text || text.length < 60) continue;
      const parsed = parseHnComment(text);
      if (!parsed) continue;
      const { title, organization, location, isRemote } = parsed;
      const { text: description } = stripHtml(text, 1800);

      records.push({
        sourceId: SOURCE_ID,
        externalId: hit.objectID,
        title,
        organization,
        category: /intern/i.test(description) ? "internship" : isRemote ? "remote_job" : "job",
        description,
        descriptionHtml: null,
        // HN comments: no direct application URL; link to the commenting posts thread
        applicationUrl: null,
        sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        location,
        remoteStatus: isRemote ? "remote" : location ? "onsite" : null,
        requiredSkills: [],
        eligibility: null,
        compensation: null,
        opensAt: null,
        applicationDeadline: null,
        eventStartsAt: null,
        eventEndsAt: null,
        sourcePublishedAt: parseIsoDate(hit.created_at ?? null),
        sourceUpdatedAt: parseIsoDate(hit.created_at ?? null),
        metadata: { attribution: "via Hacker News", hnAuthor: hit.author ?? null },
        tags: ["hiring", ...locationTokens(location)],
      });
    }

    const hasMore = (json.nbPages ?? 1) > page + 1;
    return {
      sourceId: SOURCE_ID,
      records,
      nextSyncSeconds: hasMore ? 60 : undefined,
    };
  }

  private async resolveThread(): Promise<void> {
    const json = await httpJson<{ hits: AlgoliaHit[] }>(
      `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(
        "Ask HN: Who is hiring?",
      )}&tags=ask_hn&hitsPerPage=5`,
      { rateLimit: SHARED_RATE_LIMITS.hn, timeoutMs: 20_000, retries: 1 },
    );
    const hit = (json.hits ?? []).find((h) => (h.title ?? "").startsWith("Ask HN: Who is hiring?"));
    this.threadId = hit?.objectID ?? null;
  }
}

function locationTokens(location: string | null): string[] {
  if (!location) return [];
  return location.split(/[,/]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3).slice(0, 3);
}

/**
 * HN hiring posts follow: `<p><strong>Company</strong> | Anything
 * <p>... description ... <p>Location: X
 * Returns null when the comment clearly isn't a hiring post.
 */
export function parseHnComment(html: string): { title: string; organization: string | null; location: string | null; isRemote: boolean } | null {
  const headerMatch = /<p>\s*(?:<strong>)?([^|<]{3,120})(?:<\/strong>)?\s*\|/.exec(html);
  const strongMatch = /<p><strong>([^<]{2,120})<\/strong>/.exec(html);
  const organization = (headerMatch?.[1] ?? strongMatch?.[1])?.trim();
  if (!organization || organization.length < 2) return null;

  let titleTail = "";
  if (/<p><(?:strong>)?FULL[- ]?TIME/i.test(html)) titleTail = " (full-time)";
  else if (/<p><(?:strong>)?PART[- ]?TIME/i.test(html)) titleTail = " (part-time)";

  const locationMatch = /(?:<p>\s*)?(?:Location:|location:)\s*([^<\n]{2,160})/i.exec(html);
  const location = locationMatch ? locationMatch[1]!.trim() : null;
  const isRemote =
    /[\s|]remote\b|\bwork from anywhere\b/.test(html.toLowerCase()) || /remote/i.test(location ?? "");

  return { title: `${organization}${titleTail}`, organization, location, isRemote };
}
