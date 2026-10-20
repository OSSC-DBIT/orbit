import { describe, expect, it } from "vitest";
import { matchesTenantFilters, rankOpportunities } from "../../src/opportunities/matching/matcher.js";
import type { GuildPreferencesRow } from "../../src/tenants/services/tenant-service.js";
import type { NormalizedOpportunity } from "../../src/core/types/opportunity.js";

function prefs(overrides: Partial<GuildPreferencesRow> = {}): GuildPreferencesRow {
  return {
    guildId: "111111111111111111",
    enabledCategories: [],
    includeKeywords: [],
    excludeKeywords: [],
    requiredSkills: [],
    locations: [],
    remoteOnly: false,
    paidOnly: false,
    studentsOnly: false,
    minCompensation: null,
    allowedSources: [],
    blockedSources: [],
    reminderOffsets: [10080, 2880],
    digestHours: [9],
    minConfidence: 0,
    ...overrides,
  };
}

function opp(overrides: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return {
    sourceId: "devpost",
    externalId: "1",
    title: "Qloo Agentic Hackathon",
    organization: "Qloo",
    category: "hackathon",
    description: "Build agents that reason over data",
    descriptionHtml: null,
    applicationUrl: "https://qloo.devpost.com/",
    sourceUrl: "https://qloo.devpost.com/",
    location: "Online",
    remoteStatus: "remote",
    requiredSkills: [],
    eligibility: null,
    compensation: null,
    opensAt: null,
    applicationDeadline: null,
    eventStartsAt: null,
    eventEndsAt: null,
    sourcePublishedAt: null,
    sourceUpdatedAt: null,
    metadata: {},
    tags: [],
    ...overrides,
  };
}

describe("tenant filters", () => {
  it("accepts everything for default (empty) preferences", () => {
    expect(matchesTenantFilters(opp(), prefs()).matched).toBe(true);
  });

  it("excludes blocked sources before any other filter", () => {
    const r = matchesTenantFilters(opp(), prefs({ blockedSources: ["devpost"] }));
    expect(r.matched).toBe(false);
    expect(r.excludedBy).toBe("blocked-source");
  });

  it("honors enabled categories", () => {
    expect(matchesTenantFilters(opp(), prefs({ enabledCategories: ["internship"] })).excludedBy).toBe("category");
    expect(matchesTenantFilters(opp(), prefs({ enabledCategories: ["hackathon"] })).matched).toBe(true);
  });

  it("applies hard keyword exclusions", () => {
    expect(matchesTenantFilters(opp(), prefs({ excludeKeywords: ["agents"] })).excludedBy).toBe("exclude:agents");
  });

  it("enforces remote-only against non-remote listings", () => {
    const r = matchesTenantFilters(opp({ remoteStatus: "onsite" }), prefs({ remoteOnly: true }));
    expect(r.excludedBy).toBe("remote-only");
    expect(matchesTenantFilters(opp(), prefs({ remoteOnly: true })).matched).toBe(true);
  });

  it("enforces paid-only only when compensation data exists", () => {
    expect(matchesTenantFilters(opp(), prefs({ paidOnly: true })).excludedBy).toBe("paid-only");
    expect(matchesTenantFilters(opp({ compensation: { amountMin: null, amountMax: 50000, currency: "USD", note: null } }), prefs({ paidOnly: true })).matched).toBe(true);
  });

  it("enforces minimum compensation when the source reports it", () => {
    const p = prefs({ minCompensation: 20000 });
    expect(matchesTenantFilters(opp({ compensation: { amountMin: null, amountMax: 50000, currency: "USD", note: null } }), p).matched).toBe(true);
    expect(matchesTenantFilters(opp({ compensation: { amountMin: null, amountMax: 100, currency: "USD", note: null } }), p).excludedBy).toBe("min-compensation");
  });

  it("honors the source allow list when non-empty", () => {
    expect(matchesTenantFilters(opp(), prefs({ allowedSources: ["remotive"] })).excludedBy).toBe("not-in-allowlist");
  });

  it("requires include keywords to hit at least one", () => {
    expect(matchesTenantFilters(opp(), prefs({ includeKeywords: ["rust"] })).excludedBy).toBe("include-keywords");
    expect(matchesTenantFilters(opp(), prefs({ includeKeywords: ["agent"] })).reasons[0]).toBe("keywords:agent");
  });

  it("honors locations but lets fully remote listings pass", () => {
    expect(matchesTenantFilters(opp(), prefs({ locations: ["kolkata"] })).reasons[0]).toBe("location:");
    const r = matchesTenantFilters(opp({ location: "Bengaluru", remoteStatus: "onsite" }), prefs({ locations: ["kolkata"] }));
    expect(r.excludedBy).toBe("location");
  });

  it("demands required skills in the text", () => {
    expect(matchesTenantFilters(opp(), prefs({ requiredSkills: ["rust"] })).excludedBy).toBe("required-skills");
  });
});

describe("ranking", () => {
  it("orders soonest deadlines first, then events, then newest publications", () => {
    const a = opp({ sourceId: "a", applicationDeadline: new Date("2026-11-01T00:00:00Z") });
    const b = opp({ sourceId: "b", applicationDeadline: new Date("2026-10-25T00:00:00Z") });
    const c = opp({ sourceId: "c", eventStartsAt: new Date("2026-10-22T00:00:00Z") });
    const d = opp({ sourceId: "d", sourcePublishedAt: new Date("2026-10-20T00:00:00Z") });
    const e = opp({ sourceId: "e", sourcePublishedAt: new Date("2026-10-21T00:00:00Z") });
    const ranked = rankOpportunities([e, d, c, a, b]);
    expect(ranked.map((x) => x.sourceId)).toEqual(["b", "a", "c", "e", "d"]);
  });
});
