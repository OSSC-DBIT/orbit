import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";
import { httpFetch } from "../../core/http.js";

/**
 * Source connector interface.
 *
 * Implementations must:
 *  - fetch only what the source officially publishes (API/RSS/public endpoint),
 *  - respect documented rate limits (the shared `httpFetch` throttles),
 *  - normalize into `NormalizedOpportunity` with unknown fields left null,
 *  - throw on failure; the collector records health and retries with backoff.
 */
export interface SourceConnector {
  readonly sourceId: string;
  readonly kind: "api" | "rss";
  readonly categories: string[];

  /** One synchronization run. Huge listings sets should honor `page`. */
  fetch(options?: { page?: number; cursor?: string }): Promise<ConnectorRunResult>;
}

export interface FetchPageArgs {
  page: number;
}

export type ConnectorContext = {
  config: Record<string, unknown>;
  fetch: typeof httpFetch;
};

/** Shared helpers for connectors. */
export function toRecords(items: NormalizedOpportunity[]): ConnectorRunResult extends never ? never : { records: NormalizedOpportunity[] } {
  return { records: items };
}

export const SHARED_RATE_LIMITS = {
  /** Devpost: undocumented public endpoint → keep very conservative. */
  devpost: { requests: 2, windowMs: 60_000 },
  /** Remotive: documented public API */
  remotive: { requests: 5, windowMs: 60_000 },
  /** Algolia-backed HN API: generous, still bounded */
  hn: { requests: 10, windowMs: 60_000 },
  /** 0xarchit/hackathon-api (MIT): community aggregator, cached server-side */
  hackathonApi: { requests: 4, windowMs: 60_000 },
  /** HackCulture public program API */
  hackculture: { requests: 6, windowMs: 60_000 },
} as const;

/**
 * Default sync cadence for opportunity sources: hourly. Per-source values are
 * stored in `opportunity_sources.interval_minutes` and can be tightened or
 * loosened without code changes. Delivery is deduped, so an hourly pass that
 * finds nothing new posts nothing.
 */
export const DEFAULT_SOURCE_INTERVAL_MINUTES = 60;
