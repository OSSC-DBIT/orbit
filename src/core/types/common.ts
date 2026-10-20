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
  "github_projects",
  "deadline_alerts",
  "digest",
  "ai_summaries",
  "infrastructure_alerts",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const CHANNEL_KINDS = [
  "opportunities",
  "github_alerts",
  "github_activity",
  "digest",
  "deadlines",
  "infrastructure",
] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface LevelOfDetail {
  prizeAmount?: number | null;
  prizeCurrency?: string | null;
  prizeNote?: string | null;
}
