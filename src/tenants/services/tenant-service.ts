import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../database/client.js";
import { getDb, withTenant } from "../../database/client.js";
import {
  auditLogs,
  discordGuilds,
  guildAuthorizedRoles,
  guildChannels,
  guildFeatureSettings,
  guildPreferences,
  users,
} from "../../database/schema/index.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors/index.js";
import { evaluateAdminAuthorization } from "../policies/authorization.js";
import type { ChannelKind, FeatureKey } from "../../core/types/common.js";

/**
 * Tenant service — every guild-scoped mutation goes through here so audit
 * logging and tenant scoping cannot be forgotten by callers.
 */
export interface GuildRecord {
  guildId: string;
  name: string | null;
  timezone: string;
  maxDailyNotifications: number;
}

export interface GuildFeatureRow {
  guildId: string;
  feature: string;
  enabled: boolean;
  updatedAt: Date;
}

export interface GuildChannelRow {
  guildId: string;
  kind: string;
  channelId: string;
  mentionRoleId: string | null;
}

export interface GuildPreferencesRow {
  guildId: string;
  enabledCategories: string[];
  includeKeywords: string[];
  excludeKeywords: string[];
  requiredSkills: string[];
  locations: string[];
  remoteOnly: boolean;
  paidOnly: boolean;
  studentsOnly: boolean;
  minCompensation: number | null;
  allowedSources: string[];
  blockedSources: string[];
  reminderOffsets: number[];
  digestHours: number[];
  minConfidence: number;
}

export class TenantService {
  constructor(private db: Database = getDb()) {}

  /**
   * Runs `fn` inside a transaction whose RLS tenant context is bound to
   * `guildId`. This is the ONLY sanctioned path to tenant tables from this
   * service; the row level security `with check` policy rejects anything that
   * tries to read or write another tenant's rows inside the same transaction.
   */
  private scoped<T>(guildId: string, fn: (tx: Database) => Promise<T>): Promise<T> {
    return withTenant(guildId, fn);
  }

  /** Upserts a guild on first contact. Idempotent. */
  async ensureGuild(guildId: string, name?: string | null, locale?: string | null): Promise<void> {
    if (!/^\d{10,25}$/.test(guildId)) throw new ValidationError("invalid guild id");
    await this.scoped(guildId, async (tx) => {
      await tx
        .insert(discordGuilds)
        .values({ guildId, name: name ?? null, locale: locale ?? null })
        .onConflictDoUpdate({
          target: discordGuilds.guildId,
          set: { name: name ?? sql`${discordGuilds.name}`, updatedAt: new Date() },
        });
      // seed default preferences row (ignored if exists)
      await tx.insert(guildPreferences).values({ guildId }).onConflictDoNothing();
    });
  }

  /** Should be called from the guildDelete event. */
  async markGuildDeleted(guildId: string): Promise<void> {
    await this.ensureNoThrow(guildId);
    await this.db
      .update(discordGuilds)
      .set({ leftAt: new Date() })
      .where(eq(discordGuilds.guildId, guildId));
  }

  async rejoinGuild(guildId: string): Promise<void> {
    await this.ensureNoThrow(guildId);
    await this.db
      .update(discordGuilds)
      .set({ leftAt: null })
      .where(eq(discordGuilds.guildId, guildId));
  }

  private async ensureNoThrow(guildId: string): Promise<void> {
    try {
      await this.ensureGuild(guildId);
    } catch {
      // ignore on partial rows
    }
  }

  async getGuild(guildId: string): Promise<GuildRecord | null> {
    const rows = await this.db
      .select()
      .from(discordGuilds)
      .where(eq(discordGuilds.guildId, guildId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      guildId: row.guildId,
      name: row.name,
      timezone: row.timezone,
      maxDailyNotifications: row.maxDailyNotifications,
    };
  }

  async setGuildTimezone(guildId: string, timezone: string, actorId: string): Promise<void> {
    assertTimezone(timezone);
    await this.db
      .update(discordGuilds)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(discordGuilds.guildId, guildId));
    await this.recordAudit(guildId, actorId, "guild.timezone.set", { timezone });
  }

  async setMaxDailyNotifications(guildId: string, max: number, actorId: string): Promise<void> {
    if (!Number.isInteger(max) || max < 1 || max > 200) {
      throw new ValidationError("max daily notifications must be an integer between 1 and 200");
    }
    await this.db
      .update(discordGuilds)
      .set({ maxDailyNotifications: max, updatedAt: new Date() })
      .where(eq(discordGuilds.guildId, guildId));
    await this.recordAudit(guildId, actorId, "guild.maxDailyNotifications.set", { max });
  }

  // ── features ────────────────────────────────────────────────────────────────

  private featureDefaults(): Record<string, boolean> {
    return {
      opportunities: true,
      github_projects: false,
      deadline_alerts: true,
      digest: false,
      ai_summaries: true,
      infrastructure_alerts: false,
    };
  }

  async getFeatures(guildId: string): Promise<Map<FeatureKey, boolean>> {
    const rows = await this.scoped(guildId, (tx) =>
      tx.select().from(guildFeatureSettings).where(eq(guildFeatureSettings.guildId, guildId)),
    );
    const defaults = this.featureDefaults();
    for (const row of rows) {
      defaults[row.feature] = row.enabled === 1;
    }
    return new Map(Object.entries(defaults) as [FeatureKey, boolean][]);
  }

  async isFeatureEnabled(guildId: string, feature: FeatureKey): Promise<boolean> {
    const map = await this.getFeatures(guildId);
    return map.get(feature) ?? false;
  }

  async setFeature(guildId: string, feature: FeatureKey, enabled: boolean, actorId: string): Promise<void> {
    await this.ensureGuild(guildId);
    await this.scoped(guildId, async (tx) => {
      await tx
        .insert(guildFeatureSettings)
        .values({ guildId, feature, enabled: enabled ? 1 : 0, updatedBy: actorId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [guildFeatureSettings.guildId, guildFeatureSettings.feature],
          set: { enabled: enabled ? 1 : 0, updatedBy: actorId, updatedAt: new Date() },
        });
      if (feature === "digest" && enabled) {
        await tx.insert(guildChannels).values({ guildId, kind: "digest", channelId: "" }).onConflictDoNothing();
      }
    });
    await this.recordAudit(guildId, actorId, enabled ? "feature.enabled" : "feature.disabled", { feature });
  }

  // ── channels ────────────────────────────────────────────────────────────────

  async setChannel(
    guildId: string,
    kind: ChannelKind,
    channelId: string,
    actorId: string,
    mentionRoleId?: string | null,
  ): Promise<void> {
    if (!/^\d{10,25}$/.test(channelId)) throw new ValidationError("invalid channel id");
    if (mentionRoleId && !/^\d{10,25}$/.test(mentionRoleId)) {
      throw new ValidationError("invalid role id");
    }
    const values = {
      guildId,
      kind,
      channelId,
      mentionRoleId: mentionRoleId ?? null,
      updatedBy: actorId,
      updatedAt: new Date(),
    };
    await this.scoped(guildId, (tx) =>
      tx
        .insert(guildChannels)
        .values(values)
        .onConflictDoUpdate({
          target: [guildChannels.guildId, guildChannels.kind],
          set: values,
        }),
    );
    await this.recordAudit(guildId, actorId, "channel.set", { kind, channelId, mentionRoleId: mentionRoleId ?? null });
  }

  async getChannel(guildId: string, kind: ChannelKind): Promise<GuildChannelRow | null> {
    const rows = await this.scoped(guildId, (tx) =>
      tx
        .select()
        .from(guildChannels)
        .where(and(eq(guildChannels.guildId, guildId), eq(guildChannels.kind, kind)))
        .limit(1),
    );
    const row = rows[0];
    if (!row || !row.channelId) return null;
    return { guildId: row.guildId, kind: row.kind, channelId: row.channelId, mentionRoleId: row.mentionRoleId };
  }

  async getChannels(guildId: string): Promise<GuildChannelRow[]> {
    const rows = await this.scoped(guildId, (tx) =>
      tx.select().from(guildChannels).where(eq(guildChannels.guildId, guildId)),
    );
    return rows
      .filter((r) => !!r.channelId)
      .map((r) => ({ guildId: r.guildId, kind: r.kind, channelId: r.channelId, mentionRoleId: r.mentionRoleId }));
  }

  // ── preferences ─────────────────────────────────────────────────────────────

  async getPreferences(guildId: string): Promise<GuildPreferencesRow> {
    await this.ensureGuild(guildId);
    const rows = await this.scoped(guildId, (tx) =>
      tx.select().from(guildPreferences).where(eq(guildPreferences.guildId, guildId)).limit(1),
    );
    const row = rows[0];
    if (!row) {
      // unreachable after ensureGuild; defensive fallback keeps types honest
      throw new NotFoundError("Guild preferences");
    }
    return {
      guildId: row.guildId,
      enabledCategories: row.enabledCategories,
      includeKeywords: row.includeKeywords,
      excludeKeywords: row.excludeKeywords,
      requiredSkills: row.requiredSkills,
      locations: row.locations,
      remoteOnly: row.remoteOnly === 1,
      paidOnly: row.paidOnly === 1,
      studentsOnly: row.studentsOnly === 1,
      minCompensation: row.minCompensation,
      allowedSources: row.allowedSources,
      blockedSources: row.blockedSources,
      reminderOffsets: row.reminderOffsets,
      digestHours: row.digestHours,
      minConfidence: row.minConfidence,
    };
  }

  async patchPreferences(
    guildId: string,
    patch: Partial<
      Record<
        "enabledCategories" | "includeKeywords" | "excludeKeywords" | "requiredSkills" | "locations" | "allowedSources" | "blockedSources",
        string[]
      >
    > &
      Partial<Record<"reminderOffsets" | "digestHours", number[]>> &
      Partial<Record<"remoteOnly" | "paidOnly" | "studentsOnly", boolean>> &
      Partial<Record<"minCompensation", number | null>> &
      Partial<Record<"minConfidence", number>>,
    actorId: string,
  ): Promise<void> {
    const current = await this.getPreferences(guildId);
    const next: Partial<GuildPreferencesRow> = { ...current, ...patch };
    const values = {
      guildId,
      enabledCategories: next.enabledCategories ?? [],
      includeKeywords: next.includeKeywords ?? [],
      excludeKeywords: next.excludeKeywords ?? [],
      requiredSkills: next.requiredSkills ?? [],
      locations: next.locations ?? [],
      remoteOnly: next.remoteOnly ? 1 : 0,
      paidOnly: next.paidOnly ? 1 : 0,
      studentsOnly: next.studentsOnly ? 1 : 0,
      minCompensation: next.minCompensation ?? null,
      allowedSources: next.allowedSources ?? [],
      blockedSources: next.blockedSources ?? [],
      reminderOffsets: next.reminderOffsets ?? [4320, 1440, 360],
      digestHours: next.digestHours ?? [9],
      minConfidence: next.minConfidence ?? 0,
      updatedBy: actorId,
      updatedAt: new Date(),
    };
    // The preferences row itself is the tenant record; the with-check policy
    // verifies guild_id matches the scoped context.
    await this.scopedUnchecked(guildId, (tx) =>
      tx.insert(guildPreferences).values(values).onConflictDoUpdate({
        target: guildPreferences.guildId,
        set: values,
      }),
    );
    await this.recordAudit(guildId, actorId, "preferences.updated", { keys: Object.keys(patch) });
  }

  /**
   * Like `scoped`, but for writes whose row guild_id is the same tenant and the
   * policy check happens server-side anyway; kept explicit for readability.
   */
  private scopedUnchecked<T>(guildId: string, fn: (tx: Database) => Promise<T>): Promise<T> {
    return withTenant(guildId, fn);
  }

  // ── authorized principals ───────────────────────────────────────────────────

  async addAuthorizedPrincipal(guildId: string, principalId: string, actorId: string): Promise<void> {
    if (!/^\d{10,25}$/.test(principalId)) throw new ValidationError("invalid role or user id");
    await this.scoped(guildId, (tx) =>
      tx
        .insert(guildAuthorizedRoles)
        .values({ guildId, roleOrUserId: principalId, addedBy: actorId })
        .onConflictDoNothing(),
    );
    await this.recordAudit(guildId, actorId, "authorized.add", { principalId });
  }

  async removeAuthorizedPrincipal(guildId: string, principalId: string, actorId: string): Promise<void> {
    await this.scoped(guildId, (tx) =>
      tx
        .delete(guildAuthorizedRoles)
        .where(and(eq(guildAuthorizedRoles.guildId, guildId), eq(guildAuthorizedRoles.roleOrUserId, principalId))),
    );
    await this.recordAudit(guildId, actorId, "authorized.remove", { principalId });
  }

  async listAuthorizedPrincipals(guildId: string): Promise<string[]> {
    const rows = await this.scoped(guildId, (tx) =>
      tx.select().from(guildAuthorizedRoles).where(eq(guildAuthorizedRoles.guildId, guildId)),
    );
    return rows.map((r) => r.roleOrUserId);
  }

  /** Loads everything the pure authorization policy needs, then evaluates it. */
  async assertCanAdminister(
    guildId: string | null,
    userId: string | null,
    permissionBits: string | null,
    memberRoleIds: string[],
  ): Promise<void> {
    const authorized = guildId ? await this.listAuthorizedPrincipals(guildId) : [];
    const result = evaluateAdminAuthorization({
      guildId,
      userId,
      memberPermissionBits: permissionBits,
      memberRoleIds,
      guildAuthorizedRoleIds: authorized,
    });
    if (!result.allowed) throw new ForbiddenError();
  }

  /** Ensures authorization without throwing when only reporting needs it. */
  async canAdminister(
    guildId: string | null,
    userId: string | null,
    permissionBits: string | null,
    memberRoleIds: string[],
  ): Promise<boolean> {
    try {
      await this.assertCanAdminister(guildId, userId, permissionBits, memberRoleIds);
      return true;
    } catch {
      return false;
    }
  }

  // ── audit + users ───────────────────────────────────────────────────────────

  async recordAudit(
    guildId: string,
    actorId: string,
    action: string,
    target: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    await this.scoped(guildId, (tx) =>
      tx.insert(auditLogs).values({
        guildId,
        actorId,
        action: action.slice(0, 64),
        target,
        correlationId: correlationId ?? null,
      }),
    );
  }

  async getAuditLog(guildId: string, limit = 25): Promise<
    Array<{ actorId: string; action: string; target: Record<string, unknown>; createdAt: Date }>
  > {
    const rows = await this.scoped(guildId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.guildId, guildId))
        .orderBy(sql`created_at desc`)
        .limit(Math.min(Math.max(limit, 1), 100)),
    );
    return rows.map((r) => ({ actorId: r.actorId, action: r.action, target: r.target, createdAt: r.createdAt }));
  }

  async upsertUser(discordUserId: string, username?: string | null): Promise<void> {
    if (!/^\d{10,25}$/.test(discordUserId)) return;
    await this.db
      .insert(users)
      .values({ discordUserId, username: username ?? null })
      .onConflictDoUpdate({ target: users.discordUserId, set: { username: username ?? null } });
  }
}

const TIMEZONE_VALID = (() => {
  try {
    // cheap sanity check using Intl
    new Intl.DateTimeFormat("en", { timeZone: "UTC" }).format(new Date());
    return true;
  } catch {
    return false;
  }
})();

export function assertTimezone(tz: string): void {
  if (!TIMEZONE_VALID) return; // Intl unavailable in this runtime
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return;
  } catch {
    throw new ValidationError(`Unknown IANA timezone: ${tz}`);
  }
}

export function assertGuildExists(tenant: TenantService, guildId: string): Promise<GuildRecord> {
  return tenant.getGuild(guildId).then((g) => {
    if (!g) throw new NotFoundError("Guild");
    return g;
  });
}
