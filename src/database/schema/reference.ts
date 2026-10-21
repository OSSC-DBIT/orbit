import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Reference / registry tables (not tenant-scoped):
 * users, opportunity sources + tags, infrastructure hosts and events, and the
 * job queue.
 */

export const users = pgTable("users", {
  discordUserId: varchar("discord_user_id", { length: 32 }).primaryKey(),
  username: varchar("username", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userPreferences = pgTable(
  "user_preferences",
  {
    discordUserId: varchar("discord_user_id", { length: 32 }).primaryKey(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    interests: jsonb("interests").$type<string[]>().notNull().default([]),
    notifyCategories: jsonb("notify_categories").$type<string[]>().notNull().default([]),
    quietHoursStart: integer("quiet_hours_start"),
    quietHoursEnd: integer("quiet_hours_end"),
    personalSubscribed: integer("personal_subscribed").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_preferences_subscribed_idx").on(t.personalSubscribed)],
);

export const opportunitySources = pgTable(
  "opportunity_sources",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // e.g. "devpost", "rss:<uuid>"
    kind: varchar("kind", { length: 24 }).notNull(), // api | rss
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: integer("enabled").notNull().default(1),
    /** Owner guild for guild-private sources (RSS feeds), null for global. */
    ownerGuildId: varchar("owner_guild_id", { length: 32 }),
    intervalMinutes: integer("interval_minutes").notNull().default(90),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [index("opportunity_sources_owner_idx").on(t.ownerGuildId)],
);

export const opportunityTags = pgTable(
  "opportunity_tags",
  {
    id: serial("id").primaryKey(),
    tag: varchar("tag", { length: 64 }).notNull(),
    opportunityId: integer("opportunity_id").notNull(),
  },
  (t) => [
    uniqueIndex("opportunity_tags_unique").on(t.tag, t.opportunityId),
    index("opportunity_tags_opportunity_idx").on(t.opportunityId),
  ],
);

export const infrastructureHosts = pgTable(
  "infrastructure_hosts",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    /** optional public project URL; rendered as plain text, never as a link */
    homeUrl: varchar("home_url", { length: 300 }),
    /** enrol token; only its sha256 hex is stored, the token itself never is */
    enrolTokenHash: varchar("enrol_token_hash", { length: 128 }).notNull(),
    /** Discord channel this project posts into; falls back to the guild "infrastructure" binding */
    notifyChannelId: varchar("notify_channel_id", { length: 32 }),
    /** heartbeat budget in minutes; the watchdog flags the project stale past it */
    slaMinutes: integer("sla_minutes").notNull().default(60),
    /** pending | active | stale */
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    addedBy: varchar("added_by", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("infrastructure_hosts_guild_idx").on(t.guildId),
    uniqueIndex("infrastructure_hosts_token_unique").on(t.enrolTokenHash),
    uniqueIndex("infrastructure_hosts_name_unique").on(t.guildId, t.name),
  ],
);

/** Push-in monitoring events from external projects (Bearer enrol token). */
export const infraEvents = pgTable(
  "infra_events",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    hostId: integer("host_id").notNull(),
    /** "ok" | "info" | "warn" | "error" */
    severity: varchar("severity", { length: 12 }).notNull().default("info"),
    message: text("message").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    /** watchdog rows carry occurredAt = detection time and mention it in text */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    announcedAt: timestamp("announced_at", { withTimezone: true }),
    announcedChannelId: varchar("announced_channel_id", { length: 32 }),
  },
  (t) => [
    index("infra_events_guild_time_idx").on(t.guildId, t.occurredAt),
    index("infra_events_host_time_idx").on(t.hostId, t.occurredAt),
    index("infra_events_unannounced_idx").on(t.announcedAt),
  ],
);

export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: serial("id").primaryKey(),
    jobType: varchar("job_type", { length: 64 }).notNull(),
    /** Prevents duplicate scheduling of the same logical job. */
    idempotencyKey: varchar("idempotency_key", { length: 160 }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: varchar("locked_by", { length: 64 }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    correlationId: varchar("correlation_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_jobs_claim_idx").on(t.status, t.runAt),
    index("scheduled_jobs_type_idx").on(t.jobType, t.status),
    uniqueIndex("scheduled_jobs_idempotency_unique")
      .on(t.idempotencyKey)
      .where(sql`idempotency_key is not null and status != 'cancelled'`),
  ],
);
