import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../database/client.js";
import { getDb } from "../../database/client.js";
import { opportunitySources, opportunityTags } from "../../database/schema/reference.js";
import { opportunitySourceRecords, opportunities } from "../../database/schema/opportunities.js";
import type { NormalizedOpportunity } from "../../core/types/opportunity.js";
import type { SourceConnector } from "../connectors/base.js";
import { computeContentFingerprint, computeDedupKey, sourceIdentityKey } from "../deduplication/dedupe.js";
import { getLogger } from "../../core/logging/logger.js";
import { newCorrelationId } from "../../core/ids.js";

/**
 * Collection orchestrator.
 *
 * Runs one connector, records source health, upserts canonical opportunities
 * with layered dedup, tracks provenance per source record, and marks records
 * absent from the feed as `removed` (only when the connector reported a full
 * page without pagination truncation).
 */
export interface CollectionRunStats {
  sourceId: string;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  errored: boolean;
  durationMs: number;
  /** DB ids of opportunities created OR content-updated during this run. */
  changedIds: number[];
}

export class Collector {
  constructor(private db: Database = getDb()) {}

  async run(connector: SourceConnector): Promise<CollectionRunStats> {
    const correlationId = newCorrelationId("coll");
    const start = Date.now();
    const stats: CollectionRunStats = {
      sourceId: connector.sourceId,
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      errored: true,
      durationMs: 0,
      changedIds: [],
    };
    const log = getLogger();

    try {
      const result = await connector.fetch();
      stats.fetched = result.records.length;

      for (const record of result.records) {
        const { outcome, id } = await this.upsertOpportunity(record);
        if (outcome === "created") {
          stats.created++;
          if (id) stats.changedIds.push(id);
        } else if (outcome === "updated") {
          stats.updated++;
          if (id) stats.changedIds.push(id);
        } else {
          stats.unchanged++;
        }
      }

      if (result.removedExternalIds) {
        stats.removed = await this.markRemoved(connector.sourceId, result.removedExternalIds);
      }

      stats.errored = false;
      await this.recordSourceSuccess(connector, start);
      log.info({ correlationId, sourceId: connector.sourceId }, "collection finished");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordSourceFailure(connector, message, start);
      log.error({ correlationId, sourceId: connector.sourceId, error: message }, "collection failed");
    }

    stats.durationMs = Date.now() - start;
    return stats;
  }

  /**
   * Upserts one normalized record. Deterministic, transactional.
   */
  async upsertOpportunity(record: NormalizedOpportunity): Promise<{ outcome: "created" | "updated" | "unchanged"; id: number | null }> {
    const { dedupKey } = computeDedupKey(record);
    const fingerprint = computeContentFingerprint(record);
    const now = new Date();

    return this.db.transaction(async (tx) => {
      // Layer 1: exact (sourceId, externalId)
      const existingBySource = await tx
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.sourceId, record.sourceId), eq(opportunities.externalId, record.externalId)))
        .limit(1);

      let existing = existingBySource[0];

      if (!existing) {
        // Layer 2/3: canonical dedup key (URL or title+org)
        const byDedup = await tx
          .select()
          .from(opportunities)
          .where(eq(opportunities.dedupKey, dedupKey))
          .limit(1);
        existing = byDedup[0];
      }

      if (!existing) {
        const inserted = await tx
          .insert(opportunities)
          .values({
            dedupKey,
            sourceId: record.sourceId,
            externalId: record.externalId,
            title: record.title.slice(0, 290),
            organization: record.organization,
            category: record.category,
            description: record.description,
            descriptionHtml: record.descriptionHtml,
            applicationUrl: record.applicationUrl,
            sourceUrl: record.sourceUrl,
            location: record.location,
            remoteStatus: record.remoteStatus,
            compensation: record.compensation ?? null,
            requiredSkills: record.requiredSkills,
            eligibility: record.eligibility,
            opensAt: record.opensAt,
            applicationDeadline: record.applicationDeadline,
            eventStartsAt: record.eventStartsAt,
            eventEndsAt: record.eventEndsAt,
            status: "open",
            sourcePublishedAt: record.sourcePublishedAt,
            sourceUpdatedAt: record.sourceUpdatedAt,
            contentFingerprint: fingerprint,
            confidence: 0.8,
            metadata: record.metadata,
          })
          .onConflictDoNothing()
          .returning();
        const row = inserted[0];
        if (!row) {
          // concurrent insert — treat as unchanged this run
          return { outcome: "unchanged", id: null };
        }
        await tx
          .insert(opportunitySourceRecords)
          .values({
            opportunityId: row.id,
            sourceId: record.sourceId,
            sourceExternalId: record.externalId,
            rawUrl: record.sourceUrl,
            lastSyncAt: now,
            lastSyncStatus: "present",
          })
          .onConflictDoUpdate({
            target: [opportunitySourceRecords.sourceId, opportunitySourceRecords.sourceExternalId],
            set: { lastSeenAt: now, lastSyncAt: now, lastSyncStatus: "present", rawUrl: record.sourceUrl },
          });
        await this.replaceTags(tx as unknown as Database, row.id, record.tags);
        return { outcome: "created", id: row.id };
      }

      // Existing: refresh bookkeeping
      await tx
        .insert(opportunitySourceRecords)
        .values({
          opportunityId: existing.id,
          sourceId: record.sourceId,
          sourceExternalId: record.externalId,
          rawUrl: record.sourceUrl,
          lastSeenAt: now,
          lastSyncAt: now,
          lastSyncStatus: "present",
        })
        .onConflictDoUpdate({
          target: [opportunitySourceRecords.sourceId, opportunitySourceRecords.sourceExternalId],
          set: { opportunityId: existing.id, lastSeenAt: now, lastSyncAt: now, lastSyncStatus: "present", rawUrl: record.sourceUrl },
        });

      // bookkeeping refresh only; unchanged fingerprint => no re-announce.
      // metadata still refreshes: source flags/covers change without being
      // announcement-worthy (e.g. covers, registration open state)
      if (existing.contentFingerprint === fingerprint) {
        await tx
          .update(opportunities)
          .set({
            lastSeenAt: now,
            sourceUpdatedAt: record.sourceUpdatedAt ?? existing.sourceUpdatedAt,
            status: existing.status === "removed" || existing.status === "expired" || existing.status === "closed" ? "open" : existing.status,
            metadata: record.metadata,
          })
          .where(eq(opportunities.id, existing.id));
        return { outcome: "unchanged", id: existing.id };
      }

      await tx
        .update(opportunities)
        .set({
          title: record.title.slice(0, 290),
          organization: record.organization ?? existing.organization,
          description: record.description ?? existing.description,
          applicationUrl: record.applicationUrl ?? existing.applicationUrl,
          sourceUrl: record.sourceUrl ?? existing.sourceUrl,
          location: record.location ?? existing.location,
          remoteStatus: record.remoteStatus ?? existing.remoteStatus,
          compensation: record.compensation ?? existing.compensation,
          requiredSkills: record.requiredSkills.length ? record.requiredSkills : existing.requiredSkills,
          eligibility: record.eligibility ?? existing.eligibility,
          opensAt: record.opensAt ?? existing.opensAt,
          applicationDeadline: record.applicationDeadline ?? existing.applicationDeadline,
          eventStartsAt: record.eventStartsAt ?? existing.eventStartsAt,
          eventEndsAt: record.eventEndsAt ?? existing.eventEndsAt,
          sourceUpdatedAt: record.sourceUpdatedAt ?? now,
          lastSeenAt: now,
          contentFingerprint: fingerprint,
        })
        .where(eq(opportunities.id, existing.id));
      await this.replaceTags(tx as unknown as Database, existing.id, record.tags);
      return { outcome: "updated", id: existing.id };
    });
  }

  private async replaceTags(db: Database, opportunityId: number, tags: string[]): Promise<void> {
    const unique = [...new Set(tags.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 2 && t.length <= 60))].slice(0, 20);
    await db.delete(opportunityTags).where(eq(opportunityTags.opportunityId, opportunityId));
    if (unique.length) {
      await db
        .insert(opportunityTags)
        .values(unique.map((tag) => ({ tag, opportunityId })))
        .onConflictDoNothing();
    }
  }

  /**
   * Marks records that vanished from the source (full-page sweep only).
   * The connector reports `removedExternalIds` as IDs seen previously but
   * missing from the current feed. We set lastSyncStatus="removed"; the
   * lifecycle sweep flips the canonical status after the aging window.
   */
  async markRemoved(sourceId: string, externalIds: string[]): Promise<number> {
    if (!externalIds.length) return 0;
    const now = new Date();
    const updated = await this.db.execute(sql`
      update opportunity_source_records
      set last_sync_status = 'removed', last_sync_at = ${now.toISOString()}
      where source_id = ${sourceId}
              and source_external_id = any(${sql.raw(`array[${externalIds.slice(0, 500).map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::varchar[]`)})
    `) as unknown as { rowCount?: number | null };
    return updated.rowCount ?? 0;
  }

  /**
   * Lifecycle sweep: closing_soon, expired, removed-from-source aging.
   * Runs on the scheduler periodically.
   */
  async runLifecycleSweep(options: { closingSoonDays?: number; removeAfterDays?: number; expireAfterDays?: number }): Promise<{
    closingSoon: number;
    expired: number;
    removed: number;
  }> {
    const closingSoonDays = options.closingSoonDays ?? 3;
    const expireAfterDays = options.expireAfterDays ?? 30;
    const now = new Date();
    const closingCutoff = new Date(now.getTime() + closingSoonDays * 24 * 3600 * 1000);
    const removedAgingCutoff = new Date(now.getTime() - (options.removeAfterDays ?? 7) * 24 * 3600 * 1000);
    const expireAfter = new Date(now.getTime() - expireAfterDays * 24 * 3600 * 1000);

    // 1) open → closing_soon when a deadline exists in window
    const closingSoon = await this.db
      .update(opportunities)
      .set({ status: "closing_soon", closingSoonAt: now })
      .where(
        and(
          eq(opportunities.status, "open"),
          sql`${opportunities.applicationDeadline} is not null`,
          sql`${opportunities.applicationDeadline} <= ${closingCutoff.toISOString()}`,
          sql`${opportunities.applicationDeadline} > ${now.toISOString()}`,
        ),
      )
      .returning({ id: opportunities.id });

    // 2) events that ended or deadlines passed by > expireAfterDays → expired
    const expired = await this.db
      .update(opportunities)
      .set({ status: "expired" })
      .where(
        and(
          inArray(opportunities.status, ["open", "closing_soon", "discovered", "unverified"]),
          sql`(
            (${opportunities.applicationDeadline} is not null and ${opportunities.applicationDeadline} < ${expireAfter.toISOString()})
            or
            (${opportunities.eventEndsAt} is not null and ${opportunities.eventEndsAt} < ${expireAfter.toISOString()})
          )`,
        ),
      )
      .returning({ id: opportunities.id });

    // 3) records absent from source for a while → removed
    const removed = await this.db
      .update(opportunities)
      .set({ status: "removed" })
      .where(
        and(
          eq(opportunities.status, "open"),
          sql`${opportunities.id} in (
            select sr.opportunity_id from opportunity_source_records sr
            where sr.last_sync_status = 'removed' and sr.last_seen_at < ${removedAgingCutoff.toISOString()}
          )`,
        ),
      )
      .returning({ id: opportunities.id });

    return { closingSoon: closingSoon.length, expired: expired.length, removed: removed.length };
  }

  /** Cross-source duplicate consolidation (conservative; same canon by key). */
  async consolidateDuplicates(): Promise<number> {
    const dupesRaw = await this.db.execute(sql`
      select dedup_key,
             min(id)::int as keep_id,
             string_agg(id::text, ',' order by id) as drop_ids
      from opportunities
      group by dedup_key
      having count(*) > 1
      limit 50
    `);
    const dupes = (dupesRaw as unknown as { rows: Array<{ dedup_key: string; keep_id: number; drop_ids: string }> }).rows;
    let merged = 0;
    for (const row of dupes) {
      const ids = row.drop_ids.split(",").map((id) => Number(id)).filter((id) => id !== row.keep_id);
      if (!ids.length) continue;
      await this.db.transaction(async (tx) => {
        await tx
          .update(opportunitySourceRecords)
          .set({ opportunityId: row.keep_id })
          .where(inArray(opportunitySourceRecords.opportunityId, ids));
        await tx.delete(opportunityTags).where(inArray(opportunityTags.opportunityId, ids));
        await tx.delete(opportunities).where(inArray(opportunities.id, ids));
      });
      merged += ids.length;
    }
    return merged;
  }

  private async recordSourceSuccess(connector: SourceConnector, startedAt: number): Promise<void> {
    const now = new Date(startedAt);
    await this.db
      .update(opportunitySources)
      .set({
        lastRunAt: now,
        lastSuccessAt: now,
        consecutiveFailures: 0,
        lastError: null,
      })
      .where(eq(opportunitySources.id, connector.sourceId));
  }

  private async recordSourceFailure(connector: SourceConnector, message: string, startedAt: number): Promise<void> {
    const now = new Date(startedAt);
    await this.db
      .insert(opportunitySources)
      .values({
        id: connector.sourceId,
        kind: connector.kind,
        categories: connector.categories,
        lastRunAt: now,
        consecutiveFailures: 1,
        lastError: message.slice(0, 500),
      })
      .onConflictDoUpdate({
        target: opportunitySources.id,
        set: {
          lastRunAt: now,
          consecutiveFailures: sql`${opportunitySources.consecutiveFailures} + 1`,
          lastError: message.slice(0, 500),
        },
      });
  }

  async getFeedsNeedingSync(olderThanMs: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.db
      .select({ id: opportunitySources.id })
      .from(opportunitySources)
      .where(
        and(
          eq(opportunitySources.enabled, 1),
          sql`${opportunitySources.ownerGuildId} is null or ${opportunitySources.ownerGuildId} in (select guild_id from discord_guilds where left_at is null)`,
          sql`(${opportunitySources.lastRunAt} is null or ${opportunitySources.lastRunAt} < ${cutoff.toISOString()})`,
        ),
      )
      .orderBy(desc(opportunitySources.consecutiveFailures))
      .limit(20);
    return rows.map((r) => r.id);
  }

  async seenRecently(sourceId: string, externalId: string): Promise<boolean> {
    const key = sourceIdentityKey(sourceId, externalId);
    const rows = await this.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.dedupKey, key)))
      .limit(1);
    return rows.length > 0;
  }
}
