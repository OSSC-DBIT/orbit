import { eq, sql } from "drizzle-orm";
import type { Database } from "../../database/client.js";
import { getDb } from "../../database/client.js";
import { opportunitySources } from "../../database/schema/reference.js";
import { DEFAULT_SOURCE_INTERVAL_MINUTES } from "./base.js";

/**
 * Sync preference order. The first source runs FIRST each cycle and therefore
 * claims canonical ownership of any listing several sources deliver (insert
 * once dedup: later sources only add bookkeeping rows). JobSpy is first by
 * maintainer decision (India-first jobs; Indeed + Naukri pilot), HackCulture
 * follows as the preferred campus/community hackathon source.
 */
export const SOURCE_SYNC_PRIORITY = [
  "jobspy",
  "hackculture",
  "hackathon-api",
  "devpost",
  "remotive",
  "hn-hiring",
] as const;

/**
 * Retired sources: no longer collected. Their rows stay in
 * opportunity_sources for delivery history but are force-disabled on every
 * boot so stale installs never sync them again.
 */
export const RETIRED_SOURCES = ["arbeitnow"] as const;

/**
 * Global source registry bootstrap. Idempotent; called at startup and after
 * migrations. Sources NOT listed here (guild-private RSS feeds) stay as is.
 */
export const GLOBAL_SOURCES: Array<{
  id: string;
  kind: string;
  categories: string[];
  config: Record<string, unknown>;
  intervalMinutes?: number;
  enabled: 0 | 1;
}> = [
  { id: "jobspy", kind: "api", categories: ["job", "internship"], config: {}, intervalMinutes: DEFAULT_SOURCE_INTERVAL_MINUTES, enabled: 1 },
  { id: "hackathon-api", kind: "api", categories: ["hackathon", "buildathon", "innovation_challenge", "internship"], config: {}, intervalMinutes: DEFAULT_SOURCE_INTERVAL_MINUTES, enabled: 1 },
  { id: "hackculture", kind: "api", categories: ["hackathon", "innovation_challenge", "internship"], config: {}, intervalMinutes: DEFAULT_SOURCE_INTERVAL_MINUTES, enabled: 1 },
  { id: "devpost", kind: "api", categories: ["hackathon", "buildathon", "innovation_challenge"], config: {}, intervalMinutes: DEFAULT_SOURCE_INTERVAL_MINUTES, enabled: 1 },
  { id: "remotive", kind: "api", categories: ["remote_job", "job"], config: {}, intervalMinutes: DEFAULT_SOURCE_INTERVAL_MINUTES, enabled: 1 },
  { id: "hn-hiring", kind: "api", categories: ["job", "remote_job", "internship"], config: {}, intervalMinutes: DEFAULT_SOURCE_INTERVAL_MINUTES, enabled: 1 },
];

export async function ensureDefaultSources(db: Database = getDb()): Promise<void> {
  for (const source of GLOBAL_SOURCES) {
    await db
      .insert(opportunitySources)
      .values({
        id: source.id,
        kind: source.kind,
        categories: source.categories,
        config: source.config,
        intervalMinutes: source.intervalMinutes ?? DEFAULT_SOURCE_INTERVAL_MINUTES,
        enabled: source.enabled,
      })
      .onConflictDoUpdate({
        target: opportunitySources.id,
        set: { kind: source.kind, categories: source.categories, config: source.config },
      });
  }
  for (const id of RETIRED_SOURCES) {
    await db.update(opportunitySources).set({ enabled: 0 }).where(eq(opportunitySources.id, id));
  }
}

export async function allSources(db: Database = getDb(), _ownerGuildId?: string | null): Promise<string[]> {
  const rows = await db.select({ id: opportunitySources.id }).from(opportunitySources).where(sql`${opportunitySources.enabled} = 1`);
  return rows.map((r) => r.id);
}

export async function sourceHealth(db: Database = getDb()): Promise<Array<{ id: string; lastSuccessAt: Date | null; lastError: string | null; consecutiveFailures: number }>> {
  const rows = await db
    .select({
      id: opportunitySources.id,
      lastSuccessAt: opportunitySources.lastSuccessAt,
      lastError: opportunitySources.lastError,
      consecutiveFailures: opportunitySources.consecutiveFailures,
    })
    .from(opportunitySources)
    .where(eq(opportunitySources.enabled, 1));
  return rows;
}
