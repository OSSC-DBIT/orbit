import { expect, describe, it } from "vitest";
import { listingEmbed } from "../../src/bot/commands/context.js";
import type { StoredOpportunity } from "../../src/core/types/opportunity.js";

/** The listing embed must not present a live running event as its past start
 * date, which users read as "expired". Ongoing windows show the end date. */
function baseItem(): StoredOpportunity {
  return {
    id: 1,
    sourceId: "hackathon-api",
    sourceUrl: "https://example.test/x",
    applicationUrl: "https://example.test/apply",
    title: "Sample Hackathon",
    organization: null,
    category: "hackathon",
    description: null,
    descriptionHtml: null,
    location: null,
    remoteStatus: null,
    compensation: null,
    requiredSkills: [],
    eligibility: [],
    opensAt: null,
    applicationDeadline: null,
    eventStartsAt: null,
    eventEndsAt: null,
    status: "open",
    sourcePublishedAt: null,
    sourceUpdatedAt: null,
    contentFingerprint: "fp",
    confidence: 0.8,
    metadata: {},
    tags: [],
    createdAt: new Date(),
    lastSeenAt: new Date(),
    documentTs: null,
  } as unknown as StoredOpportunity;
}

function fieldNames(embed: { data: { fields?: Array<{ name: string; value: string }> } }): string[] {
  return (embed.data.fields ?? []).map((f) => f.name);
}

describe("listingEmbed event window display", () => {
  it("shows Event starts for genuinely upcoming events", () => {
    const item = baseItem();
    item.eventStartsAt = new Date(Date.now() + 24 * 3600_000);
    const names = fieldNames(listingEmbed(item, "Asia/Kolkata"));
    expect(names).toContain("Event starts");
    expect(names).not.toContain("Event running, ends");
  });

  it("shows Event running, ends for ongoing windows instead of a past start", () => {
    const item = baseItem();
    item.eventStartsAt = new Date(Date.now() - 48 * 3600_000);
    item.eventEndsAt = new Date(Date.now() + 5 * 24 * 3600_000);
    const names = fieldNames(listingEmbed(item, "Asia/Kolkata"));
    expect(names).toContain("Event running, ends");
    expect(names).not.toContain("Event starts");
  });

  it("keeps Event starts for past windows without a live end", () => {
    const item = baseItem();
    item.eventStartsAt = new Date(Date.now() - 48 * 3600_000);
    expect(fieldNames(listingEmbed(item, "Asia/Kolkata"))).toContain("Event starts");
  });
});
