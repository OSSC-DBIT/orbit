import { httpJson } from "../../core/http.js";
import { SHARED_RATE_LIMITS, type SourceConnector } from "./base.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { stripHtml } from "../normalization/text.js";
import { parseUnixSeconds } from "../normalization/dates.js";
import { canonicalizeUrl } from "../normalization/url.js";

/**
 * Arbeitnow connector.
 *
 * Access method: documented free public API (https://www.arbeitnow.com/blog/job-board-api)
 *   https://www.arbeitnow.com/api/job-board-api?page=N
 * Verified live: slug, company_name, title, description (HTML), remote flag,
 * url, tags, job_types, location, created_at. Jobs update hourly, ordered by
 * created_at; pagination via `?page=`.
 *
 * Terms: free public API; attribution ("data from Arbeitnow") is requested by
 * the provider and included in embed source fields.
 */
const SOURCE_ID = "arbeitnow";

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number; // unix seconds
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
  links?: { next?: string | null };
  meta?: { current_page?: number };
}

export class ArbeitnowConnector implements SourceConnector {
  readonly sourceId = SOURCE_ID;
  readonly kind = "api" as const;
  readonly categories = ["job", "internship", "remote_job"];

  async fetch(options?: { page?: number }): Promise<ConnectorRunResult> {
    const page = options?.page ?? 1;
    const json = await httpJson<ArbeitnowResponse>(
      `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
      { rateLimit: SHARED_RATE_LIMITS.arbeitnow, timeoutMs: 20_000, retries: 2 },
    );
    const jobs = json.data ?? [];
    const records: NormalizedOpportunity[] = [];

    for (const job of jobs) {
      if (!job.slug || !job.title) continue;
      const { text: description } = stripHtml(job.description ?? "", 1800);
      const jobTypes = (job.job_types ?? []).map((t) => t.toLowerCase());
      const isInternship = jobTypes.some((t) => /intern/.test(t));
      const title = job.title.trim();
      records.push({
        sourceId: SOURCE_ID,
        externalId: job.slug,
        title,
        organization: job.company_name || null,
        category: isInternship ? "internship" : job.remote ? "remote_job" : "job",
        description,
        descriptionHtml: job.description?.slice(0, 2000) ?? null,
        applicationUrl: canonicalizeUrl(job.url) ?? null,
        sourceUrl: canonicalizeUrl(job.url) ?? null,
        location: job.location || null,
        remoteStatus: job.remote ? "remote" : job.location ? "onsite" : null,
        requiredSkills: (job.tags ?? []).slice(0, 20).map((t) => t.toLowerCase().trim()).filter(Boolean),
        eligibility: null,
        compensation: null,
        opensAt: null,
        applicationDeadline: null,
        eventStartsAt: null,
        eventEndsAt: null,
        sourcePublishedAt: parseUnixSeconds(job.created_at),
        sourceUpdatedAt: parseUnixSeconds(job.created_at),
        metadata: { attribution: "data from Arbeitnow", jobTypes: jobTypes.slice(0, 4) },
        tags: (job.tags ?? []).slice(0, 10).map((t) => t.toLowerCase().trim()).filter(Boolean),
      });
    }

    return { sourceId: SOURCE_ID, records };
  }
}
