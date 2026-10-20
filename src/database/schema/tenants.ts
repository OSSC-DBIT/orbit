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
 * Tenant (Discord guild) tables. Every row carries the owning `guild_id`.
 * Service layer scopes every query by guild; RLS adds a second guard (see
 * drizzle/0001_tenant_rls.sql policy for the column expression used).
 */

export const discordGuilds = pgTable("discord_guilds", {
  guildId: varchar("guild_id", { length: 32 }).primaryKey(),
  name: varchar("name", { length: 128 }),
  locale: varchar("locale", { length: 16 }),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  /** daily cap for opportunity notifications, per tenant */
  maxDailyNotifications: integer("max_daily_notifications").notNull().default(20),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** soft removal when the bot is kicked — data retained until retention GC */
  leftAt: timestamp("left_at", { withTimezone: true }),
});

export const guildFeatureSettings = pgTable(
  "guild_feature_settings",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    feature: varchar("feature", { length: 48 }).notNull(),
    enabled: integer("enabled").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 32 }),
  },
  (t) => [uniqueIndex("guild_feature_settings_unique").on(t.guildId, t.feature)],
);

export const guildChannels = pgTable(
  "guild_channels",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    /** "opportunities" | "github_alerts" | "github_activity" | "digest" | "deadlines" | "infrastructure" */
    kind: varchar("kind", { length: 32 }).notNull(),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    /** optional role to mention (validated, never @everyone) */
    mentionRoleId: varchar("mention_role_id", { length: 32 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 32 }),
  },
  (t) => [uniqueIndex("guild_channels_unique").on(t.guildId, t.kind)],
);

export const guildPreferences = pgTable(
  "guild_preferences",
  {
    guildId: varchar("guild_id", { length: 32 }).primaryKey(),
    enabledCategories: jsonb("enabled_categories").$type<string[]>().notNull().default([]),
    includeKeywords: jsonb("include_keywords").$type<string[]>().notNull().default([]),
    excludeKeywords: jsonb("exclude_keywords").$type<string[]>().notNull().default([]),
    requiredSkills: jsonb("required_skills").$type<string[]>().notNull().default([]),
    locations: jsonb("locations").$type<string[]>().notNull().default([]),
    remoteOnly: integer("remote_only").notNull().default(0),
    paidOnly: integer("paid_only").notNull().default(0),
    studentsOnly: integer("students_only").notNull().default(0),
    minCompensation: integer("min_compensation"),
    /** null = unknown sources are allowed */
    allowedSources: jsonb("allowed_sources").$type<string[]>().notNull().default([]),
    blockedSources: jsonb("blocked_sources").$type<string[]>().notNull().default([]),
    /** minutes before deadline to remind (array). default: 3 days, 1 day, 6 hours */
    reminderOffsets: jsonb("reminder_offsets").$type<number[]>().notNull().default([4320, 1440, 360]),
    digestHours: jsonb("digest_hours").$type<number[]>().notNull().default([9]),
    minConfidence: integer("min_confidence").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 32 }),
  },
  (t) => [index("guild_preferences_guild_idx").on(t.guildId)],
);

export const guildAuthorizedRoles = pgTable(
  "guild_authorized_roles",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    roleOrUserId: varchar("role_or_user_id", { length: 32 }).notNull(),
    addedBy: varchar("added_by", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("guild_authorized_roles_unique").on(t.guildId, t.roleOrUserId)],
);

export const guildProjects = pgTable(
  "guild_projects",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    repositoryFullName: varchar("repository_full_name", { length: 300 }).notNull(),
    /** "push" | "pull_request" | "issues" | "release" | "workflow" | "deployment" — empty = default set */
    alertCategories: jsonb("alert_categories").$type<string[]>().notNull().default([]),
    /** activity stream vs alerts-only */
    notifyActivity: integer("notify_activity").notNull().default(0),
    installationId: varchar("installation_id", { length: 32 }),
    verified: integer("verified").notNull().default(0),
    quietHoursStart: integer("quiet_hours_start"),
    quietHoursEnd: integer("quiet_hours_end"),
    addedBy: varchar("added_by", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("guild_projects_unique").on(t.guildId, t.repositoryFullName),
    index("guild_projects_repo_idx").on(t.repositoryFullName),
  ],
);

export const opportunityDeliveries = pgTable(
  "opportunity_deliveries",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    opportunityId: integer("opportunity_id").notNull(),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    /** "instant" | "digest" | "deadline" */
    deliveryKind: varchar("delivery_kind", { length: 16 }).notNull().default("instant"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
    messageId: varchar("message_id", { length: 32 }),
    failed: integer("failed").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    /** the heart of cross-restart dedup: one announcement per (tenant, op, channel, kind) */
    uniqueIndex("opportunity_deliveries_unique").on(
      t.guildId,
      t.opportunityId,
      t.channelId,
      t.deliveryKind,
    ),
    index("opportunity_deliveries_guild_time_idx").on(t.guildId, t.deliveredAt),
  ],
);

export const deadlineNotifications = pgTable(
  "deadline_notifications",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    opportunityId: integer("opportunity_id").notNull(),
    /** offset minutes before deadline */
    offsetMinutes: integer("offset_minutes").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failed: integer("failed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("deadline_notifications_unique").on(
      t.guildId,
      t.opportunityId,
      t.offsetMinutes,
    ),
    index("deadline_notifications_due_idx").on(t.scheduledFor, t.sentAt),
  ],
);

/** Tenant-scoped workflow run metadata extracted from webhook events. */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: serial("id").primaryKey(),
    repositoryFullName: varchar("repository_full_name", { length: 300 }).notNull(),
    runId: varchar("run_id", { length: 32 }).notNull(),
    workflowName: varchar("workflow_name", { length: 300 }),
    headBranch: varchar("head_branch", { length: 300 }),
    headSha: varchar("head_sha", { length: 64 }),
    event: varchar("event", { length: 64 }),
    status: varchar("status", { length: 32 }),
    conclusion: varchar("conclusion", { length: 32 }),
    htmlUrl: text("html_url"),
    actor: varchar("actor", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workflow_runs_unique").on(t.repositoryFullName, t.runId),
    index("workflow_runs_conclusion_idx").on(t.conclusion),
  ],
);

/** Project events cache — one row per processed GitHub event (deduped by fingerprint). */
export const projectEvents = pgTable(
  "project_events",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    repositoryFullName: varchar("repository_full_name", { length: 300 }).notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    /** dedup + idempotency across webhook replays */
    eventFingerprint: varchar("event_fingerprint", { length: 80 }).notNull(),
    deliveryId: varchar("delivery_id", { length: 64 }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    announcedAt: timestamp("announced_at", { withTimezone: true }),
    /** "activity" | "alert" — failed CI ⇒ alert */
    severity: varchar("severity", { length: 12 }).notNull().default("activity"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_events_fingerprint_unique")
      .on(t.guildId, t.eventFingerprint)
      .where(sql`1=1`),
    index("project_events_repo_time_idx").on(t.repositoryFullName, t.occurredAt),
    index("project_events_guild_time_idx").on(t.guildId, t.occurredAt),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    actorId: varchar("actor_id", { length: 32 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull().default({}),
    correlationId: varchar("correlation_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_guild_idx").on(t.guildId, t.createdAt)],
);
