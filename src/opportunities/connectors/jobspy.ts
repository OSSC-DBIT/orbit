import { fingerprintOf } from "../../core/ids.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { parseIsoDate } from "../normalization/dates.js";
import { stripHtml } from "../normalization/text.js";
import { canonicalizeUrl } from "../normalization/url.js";
import type { SourceConnector } from "./base.js";

/**
 * JobSpy connector (pilot).
 *
 * Access method: python-jobspy CLI (MIT, speedyapply/JobSpy) bundled INTO the
 * app image at /opt/jobspy. The connector spawns the CLI, which reads
 * documented-style public job search pages from the boards the maintainer
 * enabled for this pilot: Indeed + Naukri, country India. No other boards,
 * no proxies, no auth bypass: if a board blocks this host, the CLI reports
 * that board failed and we ship whatever answered honestly.
 *
 * Semantics: `job_type: internship` rows become internship category, else
 * job. Deadlines/events stay null (jobs have none: never fabricated).
 * Salary ranges and skills flow through as delivered, null when absent.
 * Attribution is per board ("via Indeed"/"via Naukri").
 */
const SOURCE_ID = "jobspy";

/** Exact CLI flags verified against jobspy 1.4.0 cli.py (Oct 2026). */
const CLI_TIMEOUT_MS = 180_000;

interface JobSpyJob {
  site?: string;
  title?: string;
  company?: string;
  location?: string;
  job_type?: string;  description?: string;
  date_posted?: string;
  job_url?: string;
  job_url_direct?: string;
  min_amount?: number;
  max_amount?: number;
  currency?: string;
  interval?: string;
  is_remote?: boolean;
  skills?: string[] | string;
}

export type JobSpyRunner = (args: string[]) => Promise<string>;

async function spawnJobSpy(args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("jobspy", args, {
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
    killSignal: "SIGKILL",
  });
  return stdout;
}

/**
 * Defensive JSONL parse: upstream already drops NaN fields, but a stray
 * bare NaN token would be invalid JSON; scrub it before parsing instead of
 * trusting versions we have not read.
 */
function parseJsonL(raw: string): JobSpyJob[] {
  const rows: JobSpyJob[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed.replace(/\bNaN\b/g, "null").replace(/\b-?Infinity\b/g, "null")) as JobSpyJob);
    } catch {
      // one malformed line must not kill the whole batch
    }
  }
  return rows;
}

function attributionFor(site: string | undefined): string {
  if (site === "indeed") return "via Indeed";
  if (site === "naukri") return "via Naukri";
  return site ? `via ${site}` : "via JobSpy";
}

export class JobSpyConnector implements SourceConnector {
  readonly sourceId = SOURCE_ID;
  readonly kind = "api" as const;
  readonly categories = ["job", "internship"];
  private readonly run: JobSpyRunner;

  constructor(runner: JobSpyRunner = spawnJobSpy) {
    this.run = runner;
  }

  async fetch(options?: { page?: number }): Promise<ConnectorRunResult> {
    const page = options?.page ?? 1;
    // CLI search is depth-limited per run; repeated pages would repeat the
    // same window. One batch per cycle, dedupe handles the overlap.
    if (page > 1) return { sourceId: SOURCE_ID, records: [] };

    const [jobs, internships] = await Promise.all([
      this.scrape("software developer", undefined),
      this.scrape("software internship", "internship"),
    ]);

    const records: NormalizedOpportunity[] = [];
    const seen = new Set<string>();
    for (const row of [...jobs, ...internships]) {
      if (!row.title || !row.job_url) continue;
      const applicationUrl = canonicalizeUrl(row.job_url) ?? canonicalizeUrl(row.job_url_direct);
      if (!applicationUrl) continue;
      const title = row.title.trim();
      const key = fingerprintOf([SOURCE_ID, row.site ?? "", applicationUrl, title]);
      if (seen.has(key)) continue;
      seen.add(key);

      const { text: description } = stripHtml(row.description ?? "", 1800);      const rawSkills = row.skills;
      const skills: string[] = Array.isArray(rawSkills)
        ? rawSkills
        : typeof rawSkills === "string"
          ? rawSkills.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      const jobType = typeof row.job_type === "string" ? row.job_type : "";
      const isInternship = /intern/.test(jobType.toLowerCase()) || /intern/i.test(title);
      records.push({
        sourceId: SOURCE_ID,
        externalId: key,
        title,
        organization: row.company?.trim() || null,
        category: isInternship ? "internship" : "job",
        description: description || null,
        descriptionHtml: null,
        applicationUrl,
        sourceUrl: null,
        location: row.location?.trim() || null,
        remoteStatus: row.is_remote ? "remote" : row.location ? "onsite" : null,
        requiredSkills: skills.slice(0, 20).map((s) => s.toLowerCase().trim()).filter(Boolean),
        eligibility: null,
        compensation:
          typeof row.min_amount === "number" || typeof row.max_amount === "number"
            ? {
                amountMin: typeof row.min_amount === "number" ? row.min_amount : null,
                amountMax: typeof row.max_amount === "number" ? row.max_amount : null,
                currency: row.currency || null,
                note: row.interval || null,
              }
            : null,
        opensAt: null,
        applicationDeadline: null,
        eventStartsAt: null,
        eventEndsAt: null,
        sourcePublishedAt: parseIsoDate(row.date_posted ?? null),
        sourceUpdatedAt: parseIsoDate(row.date_posted ?? null),
        metadata: {
          attribution: attributionFor(row.site),
          site: row.site ?? null,
          interval: row.interval ?? null,
        },
        tags: [],
      });
    }

    return { sourceId: SOURCE_ID, records };
  }

  private async scrape(searchTerm: string, jobType: string | undefined): Promise<JobSpyJob[]> {
    const args = [
      searchTerm,
      "--site", "indeed,naukri",
      "--country-indeed", "India",
      "--hours-old", "72",
      "--results-wanted", "50",
      "--description-format", "markdown",
      "--fields", "all",
    ];
    if (jobType) args.push("--job-type", jobType);
    try {
      return parseJsonL(await this.run(args));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`jobspy scrape failed for ${jobType ?? "jobs"} pass: ${detail}`);
    }
  }
}
