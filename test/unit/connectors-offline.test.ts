import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HackathonApiConnector } from "../../src/opportunities/connectors/hackathon-api.js";
import { HackCultureConnector } from "../../src/opportunities/connectors/hackculture.js";

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
