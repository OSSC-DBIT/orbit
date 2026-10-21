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
    /** "opportunities" | "digest" | "deadlines" | "infrastructure" */
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
