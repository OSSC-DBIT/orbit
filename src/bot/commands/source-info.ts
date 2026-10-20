import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../database/client.js";
import { opportunitySources, opportunities } from "../../database/schema/index.js";
import { ensureDefaultSources } from "../../opportunities/connectors/registry.js";

/** Read-model helpers shared by /status and /sources. */

export interface SourceHealthRow {
  id: string;
  kind: string;
  enabled: number;
  intervalMinutes: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export async function getSourceHealth(db: Database): Promise<SourceHealthRow[]> {
  try {
    await ensureDefaultSources(db);
  } catch {
    // tables may not exist yet in fresh test environments; report empty
  }
  try {
    const rows = await db
      .select({
        id: opportunitySources.id,
        kind: opportunitySources.kind,
        enabled: opportunitySources.enabled,
        intervalMinutes: opportunitySources.intervalMinutes,
        lastRunAt: opportunitySources.lastRunAt,
        lastSuccessAt: opportunitySources.lastSuccessAt,
        lastError: opportunitySources.lastError,
        consecutiveFailures: opportunitySources.consecutiveFailures,
      })
      .from(opportunitySources)
      .orderBy(opportunitySources.id)
      .limit(20);
    return rows;
  } catch {
    return [];
  }
}

export interface SourceStats {
  sourceId: string;
  total: number;
  open: number;
}

export async function getOpportunityCountBySource(db: Database): Promise<SourceStats[]> {
  try {
    const rows = await db
      .select({
        sourceId: opportunities.sourceId,
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where status in ('open','closing_soon'))::int`,
      })
      .from(opportunities)
      .groupBy(opportunities.sourceId)
      .orderBy(desc(sql`count(*)`))
      .limit(30);
    return rows;
  } catch {
    return [];
  }
}

export async function setSourceEnabled(db: Database, sourceId: string, enabled: 0 | 1): Promise<void> {
  await db.update(opportunitySources).set({ enabled }).where(eq(opportunitySources.id, sourceId));
}
