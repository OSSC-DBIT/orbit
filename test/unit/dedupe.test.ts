import { describe, expect, it } from "vitest";
import {
  computeDedupKey,
  computeContentFingerprint,
  areCrossSourceDuplicates,
  sourceIdentityKey,
  urlKey,
  titleOrgKey,
  jaccard,
} from "../../src/opportunities/deduplication/dedupe.js";
import type { NormalizedOpportunity } from "../../src/core/types/opportunity.js";

function opportunity(overrides: Partial<NormalizedOpportunity>): NormalizedOpportunity {
  return {
    sourceId: "devpost",
    externalId: "x-1",
    title: "Qloo Agentic Hackathon",
    organization: "Qloo",
    category: "hackathon",
    description: null,
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

describe("deduplication keys", () => {
  it("uses the canonical application URL as the dedup key when present", () => {
    const key = computeDedupKey(opportunity({ applicationUrl: "https://qloo.devpost.com/?utm_source=twitter" }));
    expect(key.strategy).toBe("url");
    expect(key.dedupKey).toBe(urlKey("https://qloo.devpost.com"));
  });

  it("falls back to title+organization when no usable URL exists", () => {
    const key = computeDedupKey(opportunity({ applicationUrl: null, sourceUrl: null, title: "Qloo Agentic Hackathon" }));
    expect(key.strategy).toBe("title-org");
    expect(key.dedupKey).toBe(titleOrgKey("Qloo Agentic Hackathon", "Qloo"));
  });

  it("falls back to source identity for very short titles", () => {
    const key = computeDedupKey(opportunity({ applicationUrl: null, sourceUrl: null, title: "Hack42", organization: null }));
    expect(key.strategy).toBe("source-identity");
    expect(key.dedupKey).toBe(sourceIdentityKey("devpost", "x-1"));
  });

  it("produces identical keys for differently-cased or tracking-laden URLs", () => {
    const a = computeDedupKey(opportunity({ applicationUrl: "https://EXAMPLE.com/hack?utm_campaign=x&fbclid=1" }));
    const b = computeDedupKey(opportunity({ applicationUrl: "https://example.com/hack" }));
    expect(a.dedupKey).toBe(b.dedupKey);
  });

  it("produces different keys for different URLs", () => {
    const a = computeDedupKey(opportunity({ applicationUrl: "https://alpha.example.com/" }));
    const b = computeDedupKey(opportunity({ applicationUrl: "https://beta.example.com/" }));
    expect(a.dedupKey).not.toBe(b.dedupKey);
  });

  it("normalizes whitespace and casing inside title+org keys", () => {
    expect(titleOrgKey("Qloo  Hackathon", "Qloo")).toBe(titleOrgKey("qloo hackathon", "qloo"));
  });
});

describe("content fingerprints", () => {
  it("changes when meaningful content changes (deadline)", () => {
    const base = computeContentFingerprint(opportunity({}));
    const moved = computeContentFingerprint(opportunity({ applicationDeadline: new Date("2026-11-01T00:00:00Z") }));
    expect(base).not.toBe(moved);
  });

  it("stays stable across null-identical opportunities", () => {
    expect(computeContentFingerprint(opportunity({}))).toBe(computeContentFingerprint(opportunity({})));
  });
});

describe("cross-source duplicates", () => {
  it("detects the same event listed on two different sources (same org)", () => {
    const a = opportunity({ sourceId: "hackathon-api", externalId: "devpost-31054", title: "Qloo Agentic Hackathon", organization: "Qloo", applicationUrl: "https://qloo.devpost.com/" });
    const b = opportunity({ sourceId: "devpost", externalId: "31054", title: "Qloo Agentic Hackathon", organization: "qloo", applicationUrl: "https://qloo.devpost.com" });
    expect(areCrossSourceDuplicates(a, b)).toBe(true);
  });

  it("detects duplicates via overlapping hosts when one org is unknown", () => {
    const a = opportunity({ sourceId: "hackathon-api", organization: null, applicationUrl: "https://qloo.devpost.com/" });
    const b = opportunity({ sourceId: "devpost", organization: "Qloo", applicationUrl: "https://qloo.devpost.com" });
    expect(areCrossSourceDuplicates(a, b)).toBe(true);
  });

  it("never merges two records from the same source", () => {
    const a = opportunity({});
    const b = opportunity({});
    expect(areCrossSourceDuplicates(a, b)).toBe(false);
  });

  it("does not merge different events whose titles are only weakly similar", () => {
    const a = opportunity({ title: "AI Hackathon", applicationUrl: "https://a.example.com/hack", organization: "Alpha" });
    const b = opportunity({ title: "AI Hackathon Finals", applicationUrl: "https://b.example.com/hack", organization: "Beta" });
    expect(areCrossSourceDuplicates(a, b)).toBe(false);
  });

  it("does not merge across categories", () => {
    const a = opportunity({ category: "internship" });
    const b = opportunity({ category: "hackathon" });
    expect(areCrossSourceDuplicates(a, b)).toBe(false);
  });
});

describe("jaccard", () => {
  it("handles empty sets", () => {
    expect(jaccardOf([], [])).toBe(0);
  });

  it("computes intersection over union", () => {
    expect(jaccardOf(["a", "b"], ["b", "c"])).toBe(1 / 3);
  });
});

function jaccardOf(a: string[], b: string[]): number {
  return jaccard(new Set(a), new Set(b));
}
