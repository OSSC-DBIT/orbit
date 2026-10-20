import { httpJson } from "../../core/http.js";
import { SHARED_RATE_LIMITS, type SourceConnector } from "./base.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { stripHtml } from "../normalization/text.js";
import { parseIsoDate } from "../normalization/dates.js";

/**
 * Remotive connector.
 *
 * Access method: documented public API (remotive.com/api/remote-jobs),
 *   params: limit, category (e.g. `software-dev`).
 * Verified live: id, url, title, company_name (→ name), description (HTML),
 * job_type, publication_date, candidate_required_location.
 * Terms: public API, usage policy at remotive.com/api-documentation —
 * attribution required; we note "via Remotive" on embeds.
 */
const SOURCE_ID = "remotive";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  job_type: string | null;
  publication_date: string;
  candidate_required_location: string | null;
  description: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

export class RemotiveConnector implements SourceConnector {
  readonly sourceId = SOURCE_ID;
  readonly kind = "api" as const;
  readonly categories = ["remote_job", "job"];

  async fetch(options?: { page?: number }): Promise<ConnectorRunResult> {
    // Remotive serves latest-first with a single page `limit`; we take two
    // bounded slices across shells of the same run to stay light.
    const limit = Math.min(Math.max(options?.page ?? 1, 1) * 50, 100);
    const json = await httpJson<RemotiveResponse>(
      `https://remotive.com/api/remote-jobs?limit=${limit}&category=software-dev`,
      { rateLimit: SHARED_RATE_LIMITS.remotive, timeoutMs: 20_000, retries: 2, headers: { "user-agent": "OrbitBot/0.1" } },
    );
    const jobs = json.jobs ?? [];
    const records: NormalizedOpportunity[] = [];

    for (const job of jobs) {
      if (!job.id || !job.title) continue;
      const { text: description } = stripHtml(job.description ?? "", 1800);
      records.push({
        sourceId: SOURCE_ID,
        externalId: String(job.id),
        title: job.title.trim(),
        organization: job.company_name || null,
        category: "remote_job",
        description,
        descriptionHtml: job.description?.slice(0, 2000) ?? null,
        applicationUrl: canonicalize(job.url),
        sourceUrl: canonicalize(job.url),
        location: job.candidate_required_location || "Remote",
        remoteStatus: "remote",
        requiredSkills: [],
        eligibility: null,
        compensation: null,
        opensAt: null,
        applicationDeadline: null,
        eventStartsAt: null,
        eventEndsAt: null,
        sourcePublishedAt: parseIsoDate(job.publication_date),
        sourceUpdatedAt: parseIsoDate(job.publication_date),
        metadata: {
          attribution: "via Remotive",
          jobType: job.job_type ?? null,
          category: job.category || null,
        },
        tags: [job.category?.toLowerCase() ?? "remote"],
      });
    }

    return { sourceId: SOURCE_ID, records };
  }
}

function canonicalize(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}
