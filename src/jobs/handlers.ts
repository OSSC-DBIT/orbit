import { eq, isNull, sql, asc } from "drizzle-orm";
import type { JobContext, Scheduler } from "./scheduler.js";
import type { DeliveryService } from "../opportunities/delivery/delivery-service.js";
import type { Collector } from "../opportunities/collectors/collector.js";
import { DeadlineScheduler } from "../opportunities/delivery/deadline-scheduler.js";
import { createConnector } from "../opportunities/connectors/index.js";
import { ensureDefaultSources, SOURCE_SYNC_PRIORITY } from "../opportunities/connectors/registry.js";
import type { Database } from "../database/client.js";
import { getDb } from "../database/client.js";
import {
  opportunitySources,
  discordGuilds,
  guildPreferences,
} from "../database/schema/index.js";
import { hoursOfDigest } from "./digest-cal.js";
import { getLogger, scopedLogger } from "../core/logging/logger.js";
import { loadConfig } from "../core/config/env.js";
import { metrics, gauge } from "../observability/metrics.js";
import { DEFAULT_TIMEZONE } from "../core/time/tz.js";
import type { StoredOpportunity } from "../core/types/opportunity.js";
import type { GuildPreferencesRow } from "../tenants/services/tenant-service.js";

/**
 * Job wiring: source sync (3-4x/day cadence per source), lifecycle sweep,
 * deadline notifications, digest dispatch, retention cleanup.
 *
 * "No repetition" guarantee chain:
 *  1. content fingerprint: unchanged listing ⇒ unchanged ⇒ no announcement;
 *  2. deliveries unique index (guild, opportunity, channel, kind): replays,
 *     restarts and concurrent workers cannot post twice;
 *  3. daily volume cap per tenant.
 */
export interface JobWiring {
  scheduler: Scheduler;
  delivery: DeliveryService;
  collector: Collector;
}

export function registerJobHandlers(wiring: JobWiring): void {
  const { scheduler } = wiring;
  scheduler.register("sync_sources", async (payload, ctx) => {
    await syncDueSourcesJob(wiring, payload, ctx);
  });
  scheduler.register("lifecycle_sweep", async () => {
    const stats = await wiring.collector.runLifecycleSweep({});
    gauge("orbit_lifecycle_last_run_epoch", Date.now());
    scopedLogger(getLogger(), { tenant: "lifecycle" }).info(stats, "lifecycle sweep complete");
  });
  scheduler.register("deadline_sweep", async () => {
    const stats = await sweepDeadlines(getDb(), wiring.delivery);
    scopedLogger(getLogger(), { tenant: "deadlines" }).info(stats, "deadline sweep complete");
  });
  scheduler.register("digest_dispatch", async () => {
    const count = await dispatchDigests(getDb(), wiring.delivery);
    gauge("orbit_digests_dispatched", count);
  });
  scheduler.register("retention_cleanup", async () => {
    const stats = await retentionCleanup(getDb());
    scopedLogger(getLogger(), { tenant: "retention" }).info(stats, "retention cleanup complete");
  });
}

async function syncDueSourcesJob(wiring: JobWiring, _payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  const db = getDb();
  const log = scopedLogger(getLogger(), { correlationId: ctx.correlationId, tenant: "sync" });
  await ensureDefaultSources(db);

  const sources = await db
    .select()
    .from(opportunitySources)
    .where(eq(opportunitySources.enabled, 1))
    // Preference order: SOURCE_SYNC_PRIORITY sources run first, so they claim
    // canonical ownership of shared listings (insert-once dedup keeps the
    // first fingerprint holder). Unknown ids (tenant RSS etc.) come last.
    .orderBy(
      sql`case ${opportunitySources.id} ${sql.join(
        SOURCE_SYNC_PRIORITY.map((id, i) => sql`when ${id} then ${i}`),
        sql` `,
      )} else ${SOURCE_SYNC_PRIORITY.length} end`,
      asc(opportunitySources.id),
    )
    .limit(30);
  const now = Date.now();

  for (const source of sources) {
    if (ctx.signal.aborted) break;
    const intervalMs = source.intervalMinutes * 60_000;
    const lastRun = source.lastRunAt ? source.lastRunAt.getTime() : 0;
    if (now - lastRun < intervalMs) continue;

    // claim so concurrent workers or restarts can't double-run
    const claimed = (await db.execute(sql`
      update opportunity_sources
      set last_run_at = now()
      where id = ${source.id}
        and (last_run_at is null or last_run_at < now() - interval '65 seconds')
    `)) as unknown as { rowCount?: number | null };
    if (!claimed.rowCount) continue;

    const connector = createConnector(source.id, source.kind, source.config ?? {});
    if (!connector) {
      await db
        .update(opportunitySources)
        .set({ lastError: "connector not available for this source kind" })
        .where(eq(opportunitySources.id, source.id));
      log.warn({ sourceId: source.id }, "no connector");
      continue;
    }

    const stats = await wiring.collector.run(connector);
    metrics.sourceRuns(stats.errored ? "error" : "ok");
    log.info({ ...stats }, "source synced");

    if (!stats.errored && stats.changedIds.length > 0) {
      await deliverFreshListings(db, wiring.delivery, stats.changedIds);
    }
  }
}

/**
 * Fans out newly created OR content-updated listings to every tenant with the
 * opportunities feature and a configured channel, respecting tenant filters
 * and daily caps. Idempotent across restarts (delivery claims).
 */
export async function deliverFreshListings(db: Database, delivery: DeliveryService, changedIds: number[]): Promise<void> {
  const items = await delivery.byIds(changedIds);
  if (!items.length) return;

  const tenants = await db
    .select({
      guildId: guildPreferences.guildId,
      prefs: guildPreferences,
      tz: discordGuilds.timezone,
      maxDaily: discordGuilds.maxDailyNotifications,
    })
    .from(guildPreferences)
    .innerJoin(discordGuilds, eq(discordGuilds.guildId, guildPreferences.guildId))
    .where(isNull(discordGuilds.leftAt))
    .limit(200);

  for (const tenant of tenants) {
    const prefs = mapPrefsRow(tenant.guildId, tenant.prefs as unknown as Record<string, unknown>);
    try {
      const result = await delivery.deliverInstant(tenant.guildId, prefs, items, tenant.maxDaily ?? 20);
      scopedLogger(getLogger(), { guildId: tenant.guildId }).info(result, "fresh listings delivered");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scopedLogger(getLogger(), { guildId: tenant.guildId }).error({ error: message }, "fresh listing delivery failed");
    }
  }
}

export async function sweepDeadlines(db: Database, delivery: DeliveryService): Promise<{ materialized: number; sent: number; failed: number }> {
  const rows = await db.select().from(guildPreferences).limit(200);
  const deadlineScheduler = new DeadlineScheduler(db);
  let materialized = 0;
  for (const row of rows) {
    const prefs = mapPrefsRow(row.guildId, row as unknown as Record<string, unknown>);
    const open = await delivery.eligibleFor(row.guildId, prefs, 60);
    const withDeadline = open.filter((o: StoredOpportunity) => !!o.applicationDeadline);
    materialized += await deadlineScheduler.materializeForTenant(prefs, withDeadline);
  }
  const send = await deadlineScheduler.sendDue(async (guildId, opp) => {
    const result = await delivery.deliverOne(guildId, "deadlines", opp, "deadline");
    metrics.deliveries("deadline", result);
    return result;
  });
  return { materialized, sent: send.sent, failed: send.failed };
}

export async function dispatchDigests(db: Database, delivery: DeliveryService): Promise<number> {
  const rows = await db
    .select({ guildId: guildPreferences.guildId, prefs: guildPreferences, tz: discordGuilds.timezone })
    .from(guildPreferences)
    .innerJoin(discordGuilds, eq(discordGuilds.guildId, guildPreferences.guildId))
    .limit(200);

  const now = new Date();
  let dispatched = 0;
  for (const row of rows) {
    const hourInTz = hoursOfDigest(now, row.tz || DEFAULT_TIMEZONE);
    const hours = row.prefs.digestHours?.length ? row.prefs.digestHours : [9];
    if (!hours.some((h) => h === hourInTz)) continue;

    const prefs = mapPrefsRow(row.guildId, row.prefs as unknown as Record<string, unknown>);
    const items = (await delivery.eligibleFor(row.guildId, prefs, 80)) as Array<Pick<StoredOpportunity, "id">>;
    if (!items.length) continue;
    const payload = await delivery.buildDigest(row.guildId, prefs, items as StoredOpportunity[]);
    if (!payload) continue;

    const sent = await delivery.sendDigest(row.guildId, payload);
    if (sent) {
      dispatched++;
      metrics.deliveries("digest", "delivered");
    }
  }
  return dispatched;
}

/** Narrow DB row to the domain shape with tenant-safe defaults. */
function mapPrefsRow(guildId: string, row: Record<string, unknown>): GuildPreferencesRow {
  return {
    guildId,
    enabledCategories: (row.enabledCategories as string[]) ?? [],
    includeKeywords: (row.includeKeywords as string[]) ?? [],
    excludeKeywords: (row.excludeKeywords as string[]) ?? [],
    requiredSkills: (row.requiredSkills as string[]) ?? [],
    locations: (row.locations as string[]) ?? [],
    remoteOnly: row.remoteOnly === 1,
    paidOnly: row.paidOnly === 1,
    studentsOnly: row.studentsOnly === 1,
    minCompensation: (row.minCompensation as number | null) ?? null,
    allowedSources: (row.allowedSources as string[]) ?? [],
    blockedSources: (row.blockedSources as string[]) ?? [],
    reminderOffsets: (row.reminderOffsets as number[]) ?? [4320, 1440, 360],
    digestHours: (row.digestHours as number[]) ?? [9],
    minConfidence: (row.minConfidence as number) ?? 0,
  };
}

export async function retentionCleanup(db: Database): Promise<{ auditLogs: number; jobs: number }> {
  const days = loadConfig().RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const auditLogs = (await db.execute(sql`delete from audit_logs where created_at < ${cutoff}`)) as unknown as {
    rowCount?: number | null;
  };
  const jobs = (await db.execute(
    sql`delete from scheduled_jobs where status in ('done','failed') and updated_at < ${cutoff}`,
  )) as unknown as { rowCount?: number | null };
  return { auditLogs: auditLogs.rowCount ?? 0, jobs: jobs.rowCount ?? 0 };
}

/** Ensures recurring jobs exist (idempotent; runs at startup). */
export function recurringIntervals(): Record<string, Record<string, unknown>> {
  return {
    sync_sources: { intervalSeconds: 3600 }, // hourly parent pass; per-source gating uses interval_minutes
    lifecycle_sweep: { intervalSeconds: 3600 },
    deadline_sweep: { intervalSeconds: 15 * 60 },
    digest_dispatch: { intervalSeconds: 3600 },
    retention_cleanup: { intervalSeconds: 24 * 3600 },
  };
}
