import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HackathonApiConnector } from "../../src/opportunities/connectors/hackathon-api.js";
import { HackCultureConnector } from "../../src/opportunities/connectors/hackculture.js";
import { JobSpyConnector } from "../../src/opportunities/connectors/jobspy.js";

/**
 * Connector tests run fully offline: global fetch is stubbed with recorded
 * fixtures that replicate the verified live response shapes (Oct 2026).
 */

type FetchCall = { url: string };

let calls: FetchCall[] = [];

function installFetch(responder: (url: string) => Response | { status: number }) {
  const stub = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url });
    const out = responder(url);
    if (out instanceof Response) return out;
    return new Response("upstream error", { status: out.status });
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("hackathon-api connector (0xarchit/hackathon-api, MIT)", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a live-shaped aggregate response into normalized records", async () => {
    installFetch(() =>
      jsonResponse({
        status: "success",
        count: 3,
        platform_counts: { devpost: 1, unstop: 1, mlh: 1 },
        generated_at: "2026-10-20T09:08:35Z",
        data: [
          {
            id: "devpost-31054",
            title: "Qloo Agentic Hackathon",
            platform: "devpost",
            mode: "online",
            location: "Online",
            country: "India",
            start_date: "2026-09-30",
            end_date: "2027-01-30",
            registration_end: "2026-12-31",
            url: "https://qloo.devpost.com/",
            prize_pool: "₹10,00,000",
            tags: ["AI", "Agents"],
          },
          {
            // verifiably ended: must be dropped
            id: "unstop-1",
            title: "Ancient Event",
            platform: "unstop",
            mode: "offline",
            location: "Bengaluru",
            country: "India",
            start_date: "2024-01-01",
            end_date: "2024-01-05",
            registration_end: "2023-12-30",
            url: "https://unstop.com/h/old",
          },
          {
            // no dates anywhere: cannot be verified as open, dropped
            id: "mlh-1",
            title: "No Dates Anywhere",
            platform: "mlh",
            mode: "online",
            location: "TBA",
            country: "India",
            start_date: null,
            end_date: null,
            registration_end: null,
            url: "https://mlh.io/event",
          },
        ],
      }),
    );

    const connector = new HackathonApiConnector({ baseUrl: "https://api.test-ha" });
    const result = await connector.fetch();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test-ha/api/v1/hackathons");
    expect(result.sourceId).toBe("hackathon-api");
    expect(result.records).toHaveLength(1);

    const rec = result.records[0]!;
    expect(rec.externalId).toBe("devpost-31054");
    expect(rec.title).toBe("Qloo Agentic Hackathon");
    expect(rec.category).toBe("hackathon");
    expect(rec.remoteStatus).toBe("remote");
    expect(rec.location).toBe("Online"); // structured location preserved
    expect(rec.applicationUrl).toBe("https://qloo.devpost.com/");
    expect(rec.eventStartsAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(rec.eventEndsAt?.toISOString()).toBe("2027-01-30T23:59:59.000Z");
    // registration deadline is the source-provided registration_end at end of day
    expect(rec.applicationDeadline?.toISOString()).toBe("2026-12-31T23:59:59.000Z");
    expect(rec.compensation).toEqual({ amountMin: null, amountMax: 1000000, currency: "INR", note: null });
    expect(rec.requiredSkills).toEqual(["ai", "agents"]);
    expect(rec.tags).toEqual(["hackathon", "devpost", "ai", "agents"]);
    expect(rec.metadata.attribution).toBe("via 0xarchit/hackathon-api (MIT)");
    expect(rec.metadata.upstreamPlatform).toBe("devpost");
  });

  it("keeps unparseable prize pools as text notes instead of inventing numbers", async () => {
    installFetch(() =>
      jsonResponse({
        status: "success",
        data: [
          {
            id: "p-1",
            title: "Prize Pool Weird Format",
            platform: "devfolio",
            mode: "online",
            location: "Online",
            country: "India",
            start_date: "2026-11-01",
            end_date: "2026-11-10",
            registration_end: null,
            url: "https://example.org/prize",
            prize_pool: "TBA",
          },
        ],
      }),
    );
    const result = await new HackathonApiConnector({ baseUrl: "https://api.test-hb" }).fetch();
    expect(result.records[0]!.compensation).toEqual({ amountMin: null, amountMax: null, currency: null, note: "TBA" });
    expect(result.records[0]!.applicationDeadline).toBeNull();
  });

  it("throws (and lets the scheduler retry) when the upstream API fails", async () => {
    installFetch(() => ({ status: 500 }));
    await expect(new HackathonApiConnector({ baseUrl: "https://api.test-hc5" }).fetch()).rejects.toThrow();
  });
});

describe("hackculture connector", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads public cards, skips completed ones and never invents a deadline", async () => {
    installFetch(() =>
      jsonResponse([
        {
          _id: "68f9f4a86bc62122eb4f4656",
          name: "VTION INNOVATE HACKATHON",
          tagline: "Join OTT Hackathon, where elite builders compete",
          type: "hackathon",
          industry: "technology",
          min_team_size: 1,
          max_team_size: 4,
          mode: "offline",
          status: "published",
          is_completed: false,
          location: { name: "Bengaluru", address: "Somewhere in Bengaluru" },
          start_datetime: "2026-11-11T03:24:00Z",
          end_datetime: "2026-12-30T09:25:00Z",
          slug: "vtion-innovate-hackathon",
          organizer_name: "VTION",
          // live API shape re-verified Oct 2026: {name,value} tag pairs
          tags: [{ name: "is_featured", value: "false" }],
          branding: { cover_photo: "https://hackcultureplatform.example.test/event-assets/cover.jpg", logo: null },
          is_registration_open: true,
          external_registration_url: "https://unstop.com/h/vtion?ref=x",
        },
        {
          // completed: filtered out
          _id: "completed-1",
          name: "Completed Challenge",
          slug: "completed-challenge",
          status: "published",
          is_completed: true,
        },
        {
          // ended before today: dropped by the today anchored freshness gate
          _id: "ended-1",
          name: "Ended Event",
          slug: "ended-event",
          type: "hackathon",
          status: "published",
          is_completed: false,
          is_registration_open: true,
          start_datetime: "2026-09-01T09:00:00Z",
          end_datetime: "2026-09-10T18:00:00Z",
        },
        {
          // undated cards are dropped per AGENTS.md (never surface guesses)
          _id: "undated-1",
          name: "Undated Program Page",
          slug: "undated-program-page-challenge",
          type: "innovation_challenge",
          status: "published",
          is_completed: false,
          location: null,
          mode: null,
          tags: null,
        },
      ]),
    );

    const result = await new HackCultureConnector({ baseUrl: "https://hc.test" }).fetch();

    expect(calls).toHaveLength(1); // single page under the 50-item page size
    expect(calls[0]!.url).toBe("https://hc.test/api/v1/hackathons?response_type=card&limit=50&skip=0");
    expect(result.sourceId).toBe("hackculture");
    expect(result.records).toHaveLength(1); // ended + undated + registration closed are all dropped

    const first = result.records[0]!;
    expect(first.organization).toBe("VTION");
    expect(first.applicationUrl).toBe("https://unstop.com/h/vtion");
    expect(first.sourceUrl).toBe("https://hackculture.io/programs/vtion-innovate-hackathon");
    expect(first.eventStartsAt?.toISOString()).toBe("2026-11-11T03:24:00.000Z");
    expect(first.eventEndsAt?.toISOString()).toBe("2026-12-30T09:25:00.000Z");
    expect(first.applicationDeadline).toBeNull(); // the platform card has no deadline field
    expect(first.eligibility).toEqual(["Team size: 1-4"]);
    expect(first.remoteStatus).toBe("onsite");
    expect(first.location).toBe("Bengaluru");
    expect(first.metadata.attribution).toBe("via HackCulture");
    expect(first.metadata.isRegistrationOpen).toBe(true);
    expect(first.tags).toContain("hackculture");
    expect(first.tags).toContain("is_featured"); // extracted from {name,value} pair
    expect(first.metadata.coverImage).toBe("https://hackcultureplatform.example.test/event-assets/cover.jpg");
  });
});

describe("jobspy connector (Indeed + Naukri pilot via bundled CLI)", () => {
  // Fixture lines mirror the CLI JSONL shape verified in records.py:
  // fields the board did not provide are simply absent (no NaN tokens);
  // one raw NaN line is included to prove the defensive scrubber.
  const INDEED_LINE = JSON.stringify({
    site: "indeed",
    title: "Backend Engineer",
    company: "Paytm",
    location: "Bengaluru, India",
    job_type: "fulltime",
    description: "Build the payments backend",
    date_posted: "2026-10-18",
    job_url: "https://www.indeed.com/viewjob?jk=abc123",
    min_amount: 1200000,
    max_amount: 1800000,
    currency: "INR",
    interval: "yearly",
    is_remote: false,
    skills: ["java", "kafka"],
  });
  const NAUKRI_LINE = JSON.stringify({
    site: "naukri",
    title: "Software Intern",
    company: "Zoho",
    location: "Chennai, India",
    job_type: "internship",
    description: "Work with the frontend team",
    date_posted: "2026-10-19 00:00:00",
    job_url: "https://www.naukri.com/joblisting?id=123",
    is_remote: false,
  });
  // Handcrafted row with bare NaN tokens (invalid JSON from a flawed
  // upstream): the connector's scrubber must neutralize them, proving the
  // safety net without relying on upstream never regressing.
  const NAN_LINE =
    '{"site":"indeed","title":"Data Engineer","company":"Flipkart","job_url":"https://www.indeed.com/viewjob?jk=nan-row","min_amount":NaN,"max_amount":NaN,"currency":NaN}';

  function fakeRunner(lines: string[]): { runner: (args: string[]) => Promise<string>; calls: string[][] } {
    const calls: string[][] = [];
    return {
      runner: async (args: string[]) => {
        calls.push(args);
        return lines.join("\n") + "\n";
      },
      calls,
    };
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the verified 1.4.0 CLI flags and maps both boards", async () => {
    const { runner, calls } = fakeRunner([INDEED_LINE, NAUKRI_LINE]);
    const { records } = await new JobSpyConnector(runner).fetch();

    expect(calls).toHaveLength(2);
    expect(calls).toHaveLength(2);
    const jobArgs = calls[0]!;
    const internArgs = calls[1]!;
    const argValue = (args: string[], flag: string): string => {
      const idx = args.indexOf(flag);
      expect(idx).toBeGreaterThanOrEqual(0);
      return args[idx + 1] ?? "";
    };
    expect(argValue(jobArgs, "--site")).toBe("indeed,naukri");
    expect(argValue(jobArgs, "--country-indeed")).toBe("India");
    expect(argValue(jobArgs, "--fields")).toBe("all");
    expect(jobArgs).not.toContain("--job-type");
    expect(argValue(internArgs, "--job-type")).toBe("internship");

    expect(records).toHaveLength(2);
    const job = records[0]!;
    expect(job.title).toBe("Backend Engineer");
    expect(job.category).toBe("job");
    expect(job.organization).toBe("Paytm");
    expect(job.applicationUrl).toBe("https://indeed.com/viewjob?jk=abc123");
    expect(job.description).toBe("Build the payments backend");
    expect(job.compensation?.currency).toBe("INR");
    expect(job.compensation?.amountMin).toBe(1200000);
    expect(job.metadata.attribution).toBe("via Indeed");
    expect(job.sourcePublishedAt).toBeInstanceOf(Date);

    const intern = records[1]!;
    expect(intern.category).toBe("internship");
    expect(intern.metadata.attribution).toBe("via Naukri");
    expect(intern.compensation).toBeNull();
    expect(intern.applicationDeadline).toBeNull();
  });

  it("survives a malformed line and dedupes identical rows", async () => {
    const { runner } = fakeRunner(["not json at all", INDEED_LINE, INDEED_LINE]);
    const { records } = await new JobSpyConnector(runner).fetch();
    expect(records).toHaveLength(1);
  });

  it("scrubs bare NaN tokens as a safety net", async () => {
    const { runner } = fakeRunner([NAN_LINE]);
    const { records } = await new JobSpyConnector(runner).fetch();
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("Data Engineer");
  });

  it("surfaces CLI failure as a thrown error (source health)", async () => {
    const runner = async () => {
      throw new Error("Command failed: jobspy exit 1");
    };
    await expect(new JobSpyConnector(runner).fetch()).rejects.toThrow(/jobspy scrape failed/);
  });
});
