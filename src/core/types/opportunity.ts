import type { OpportunityCategory, OpportunityStatus } from "./common.js";

/**
 * Normalized opportunity — the canonical in-memory shape produced by source
 * connectors after normalization. Unknown values stay `null`/`undefined`;
 * they are NEVER invented.
 */
export interface NormalizedOpportunity {
  /** Stable within-source identifier (may be a slug/URL if no numeric ID exists). */
  externalId: string;
  sourceId: string;
  title: string;
  organization: string | null;
  category: OpportunityCategory;
  /** Plain-text description (HTML stripped), ≤ ~2000 chars. */
  description: string | null;
  descriptionHtml: string | null;
  /** The URL a candidate should use to apply / register. */
  applicationUrl: string | null;
  /** Where on the source this listing lives (may equal applicationUrl). */
  sourceUrl: string | null;
  location: string | null;
  /** null = unknown; never guessed. */
  remoteStatus: "remote" | "onsite" | "hybrid" | null;
  requiredSkills: string[];
  eligibility: string[] | null;
  compensation: { amountMin: number | null; amountMax: number | null; currency: string | null; note: string | null } | null;
  opensAt: Date | null;
  applicationDeadline: Date | null;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  sourcePublishedAt: Date | null;
  sourceUpdatedAt: Date | null;
  /** Optional structured extras the source provides (already redacted). */
  metadata: Record<string, unknown>;
  tags: string[];
}

/** The DB row shape of a canonical opportunity (subset that mirrors relations). */
export interface StoredOpportunity {
  id: number;
  dedupKey: string;
  sourceId: string;
  externalId: string;
  title: string;
  organization: string | null;
  category: OpportunityCategory;
  description: string | null;
  descriptionHtml: string | null;
  applicationUrl: string | null;
  sourceUrl: string | null;
  location: string | null;
  remoteStatus: string | null;
  compensation: {
    amountMin: number | null;
    amountMax: number | null;
    currency: string | null;
    note: string | null;
  } | null;
  requiredSkills: string[];
  eligibility: string[] | null;
  opensAt: Date | null;
  applicationDeadline: Date | null;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  status: OpportunityStatus;
  closingSoonAt: Date | null;
  firstDiscoveredAt: Date;
  lastSeenAt: Date;
  lastVerifiedAt: Date | null;
  sourcePublishedAt: Date | null;
  sourceUpdatedAt: Date | null;
  contentFingerprint: string;
  aiSummary: string | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
}

/** Result of a connector run (normalized upstream info before deduplication). */
export interface ConnectorRunResult {
  sourceId: string;
  /** Listings seen in this run. */
  records: NormalizedOpportunity[];
  /** External IDs that disappeared from the source and can be marked removed. */
  removedExternalIds?: string[];
  /** Connector may request its next sync run_at offset (seconds). */
  nextSyncSeconds?: number;
}

export interface ConnectorHealth {
  sourceId: string;
  ok: boolean;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  listingsSeen: number;
}
