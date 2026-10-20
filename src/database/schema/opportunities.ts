import { index, integer, jsonb, pgTable, real, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/**
 * Canonical opportunities + per-source records.
 * `opportunities` is the deduplicated, cross-source canon.
 */

export interface CompensationRow {
  amountMin: number | null;
  amountMax: number | null;
  currency: string | null;
  note: string | null;
}

export const opportunities = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    /** deterministic dedup key (see normalization/dedup.ts) */
    dedupKey: varchar("dedup_key", { length: 80 }).notNull(),
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    externalId: varchar("external_id", { length: 300 }).notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    organization: varchar("organization", { length: 200 }),
    category: varchar("category", { length: 32 }).notNull(),
    description: text("description"),
    descriptionHtml: text("description_html"),
    applicationUrl: text("application_url"),
    sourceUrl: text("source_url"),
    location: varchar("location", { length: 200 }),
    /** remote | onsite | hybrid | null */
    remoteStatus: varchar("remote_status", { length: 12 }),
    compensation: jsonb("compensation").$type<CompensationRow>(),
    requiredSkills: jsonb("required_skills").$type<string[]>().notNull().default([]),
    eligibility: jsonb("eligibility").$type<string[]>(),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    applicationDeadline: timestamp("application_deadline", { withTimezone: true }),
    eventStartsAt: timestamp("event_starts_at", { withTimezone: true }),
    eventEndsAt: timestamp("event_ends_at", { withTimezone: true }),
    status: varchar("status", { length: 16 }).notNull().default("discovered"),
    /** when status flips to closing_soon */
    closingSoonAt: timestamp("closing_soon_at", { withTimezone: true }),
    firstDiscoveredAt: timestamp("first_discovered_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    sourcePublishedAt: timestamp("source_published_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    /** fingerprint of normalized content — unchanged listings don't re-announce */
    contentFingerprint: varchar("content_fingerprint", { length: 80 }).notNull(),
    aiSummary: text("ai_summary"),
    /** 0..1 normalized source/parse confidence */
    confidence: real("confidence"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("opportunities_dedup_unique").on(t.dedupKey),
    /** also constrain per-source: one canon per (source, external id) pair */
    uniqueIndex("opportunities_source_external_unique").on(t.sourceId, t.externalId),
    index("opportunities_category_idx").on(t.category, t.status),
    index("opportunities_deadline_idx").on(t.applicationDeadline),
    index("opportunities_event_idx").on(t.eventStartsAt),
    index("opportunities_fingerprint_idx").on(t.contentFingerprint),
  ],
);

/** Per-source raw record tracking: provenance + sync bookkeeping. */
export const opportunitySourceRecords = pgTable(
  "opportunity_source_records",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").notNull(),
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    sourceExternalId: varchar("source_external_id", { length: 300 }).notNull(),
    rawUrl: text("raw_url"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** one of: present | removed | errored */
    lastSyncStatus: varchar("last_sync_status", { length: 12 }).notNull().default("present"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("opportunity_source_records_unique").on(t.sourceId, t.sourceExternalId),
    index("opportunity_source_records_opportunity_idx").on(t.opportunityId),
  ],
);

/** Job/board metric counters used by /status and the protected metrics endpoint. */
export const botMetrics = pgTable(
  "bot_metrics",
  {
    id: serial("id").primaryKey(),
    metric: varchar("metric", { length: 80 }).notNull(),
    value: jsonb("value").$type<Record<string, number | string | boolean>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bot_metrics_metric_unique").on(t.metric)],
);
