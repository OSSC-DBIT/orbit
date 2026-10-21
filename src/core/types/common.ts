/** Core domain types shared across Orbit modules. */

export const OPPORTUNITY_CATEGORIES = [
  "hackathon",
  "buildathon",
  "internship",
  "job",
  "remote_job",
  "opensource_program",
  "student_program",
  "research",
  "innovation_challenge",
  "grant_fellowship",
] as const;

export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

export const OPPORTUNITY_STATUSES = [
  "discovered",
  "open",
  "closing_soon",
  "closed",
  "expired",
  "unverified",
  "removed",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const FEATURE_KEYS = [
  "opportunities",
  "deadline_alerts",
  "digest",
  "ai_summaries",
  "infrastructure_alerts",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const CHANNEL_KINDS = [
  "opportunities",
  "hackathons",
  "jobs",
  "internships",
  "digest",
  "deadlines",
  "infrastructure",
] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * Category aware channel routing: which dedicated channel kind an opportunity
 * of the given category posts into, or null to use the guild's
 * "opportunities" binding as the catch-all. Deliberately narrow: niche
 * categories (opensource_program, student_program, research,
 * innovation_challenge, grant_fellowship) share the opportunities feed
 * instead of each demanding a channel.
 */
export function channelKindForCategory(category: string): ChannelKind | null {
  switch (category) {
    case "hackathon":
    case "buildathon":
      return "hackathons";
    case "internship":
      return "internships";
    case "job":
    case "remote_job":
      return "jobs";
    default:
      return null;
  }
}

export interface LevelOfDetail {
  prizeAmount?: number | null;
  prizeCurrency?: string | null;
  prizeNote?: string | null;
}
