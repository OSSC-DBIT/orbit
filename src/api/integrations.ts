import { type Request, type Response, type NextFunction, type Router } from "express";
import { sql } from "drizzle-orm";
import type { Database } from "../database/client.js";
import { safeEquals } from "../core/security/crypto.js";

/**
 * External integration API (machine to machine).
 *
 *   GET /api/integrations/health        full health report (JSON)
 *   GET /api/integrations/logs          recent structured log/failure events
 *
 * Auth: `Authorization: Bearer <INTEGRATION_API_TOKEN>` (falls back to
 * ADMIN_API_TOKEN). Without a token the integration surface is disabled and
 * answers 503 so a forgot-config deploy never exposes diagnostics.
 *
 * The health report is a single self-contained JSON document designed for
 * external dashboards, cron monitors or status pages:
 *   { status: healthy|degraded|unhealthy, database, scheduler,
 *     sources, deliveries, catalog, jobs }
 */

export interface OrchestratedProbe {
  dbLatencyMs: number | null;
  dbReachable: boolean;
}

interface LogEvent {
  ts: string;
  severity: "error" | "warn" | "info";
  origin: "jobs" | "sources" | "deliveries" | "audit";
  message: string;
  context: Record<string, unknown>;
}

export function integrationToken(): string | null {
  const raw = process.env.INTEGRATION_API_TOKEN ?? process.env.ADMIN_API_TOKEN ?? "";
  return raw.length >= 16 ? raw : null;
}

export function integrationGuard(req: Request, res: Response, next: NextFunction): void {
  const token = integrationToken();
  if (!token) {
    res.status(503).json({ error: "integration API disabled (set INTEGRATION_API_TOKEN or ADMIN_API_TOKEN)" });
    return;
  }
  const provided = req.headers.authorization;
  if (provided?.startsWith("Bearer ") && safeEquals(provided.slice(7), token)) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}

/** Builds the full health report. Throws only on dead DB connection. */
export async function buildIntegrationReport(db: Database): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<string, unknown>;
  warnings: string[];
}> {
  const started = Date.now();
  await db.execute(sql`select 1`); // throws 5xx upstream when unreachable
  const dbLatencyMs = Date.now() - started;

  const one = async <T>(q: Promise<{ rows: T[] }>): Promise<T[]> => {
    try {
      return (await q).rows;
    } catch {
      return [];
    }
  };

  const [schedulerStatuses, failedJobs, pendingAges, sources, deliveries24h, catalog, guildCount] =
    await Promise.all([
      one(db.execute(sql`select status, count(*)::int as n from scheduled_jobs group by status`) as unknown as Promise<{ rows: Array<{ status: string; n: number }> }>),
      one(
        db.execute(
          sql`select job_type, attempts, max_attempts, last_error, updated_at from scheduled_jobs where status = 'failed' order by updated_at desc limit 20`,
        ) as unknown as Promise<{ rows: Array<{ job_type: string; attempts: number; max_attempts: number; last_error: string | null; updated_at: string }> }>,
      ),
      one(
        db.execute(
          sql`select count(*)::int as stuck from scheduled_jobs where status = 'pending' and run_at < now() - interval '1 hour'`,
        ) as unknown as Promise<{ rows: Array<{ stuck: number }> }>,
      ),
      one(
        db.execute(
          sql`select id, enabled, interval_minutes, last_run_at, last_success_at, last_error, consecutive_failures from opportunity_sources order by id`,
        ) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
      ),
      one(
        db.execute(
          sql`select count(*)::int as delivered,
                     sum(case when failed = 1 then 1 else 0 end)::int as failed
              from opportunity_deliveries where delivered_at > now() - interval '24 hours'`,
        ) as unknown as Promise<{ rows: Array<{ delivered: number; failed: number }> }>,
      ),
      one(
        db.execute(
          sql`select count(*)::int as total,
                     count(*) filter (where status in ('open','closing_soon'))::int as open,
                     count(*) filter (where status = 'closing_soon')::int as closing_soon,
                     count(*) filter (where application_deadline is not null and application_deadline > now())::int as with_deadline
              from opportunities`,
        ) as unknown as Promise<{ rows: Array<{ total: number; open: number; closing_soon: number; with_deadline: number }> }>,
      ),
      one(
        db.execute(sql`select count(*)::int as n from discord_guilds where left_at is null`) as unknown as Promise<{
          rows: Array<{ n: number }>;
        }>,
      ),
    ]);

  const statuses = Object.fromEntries(schedulerStatuses.map((r) => [r.status, r.n]));
  const stuckPending = pendingAges[0]?.stuck ?? 0;
  const failingSources = (sources as Array<Record<string, unknown>>).filter(
    (s) => Number(s.consecutive_failures) >= 3 && !s.last_success_at,
  );

  const warnings: string[] = [];
  if (failedJobs.length) warnings.push(`${failedJobs.length} failed job(s): first is ${failedJobs[0]?.job_type}`);
  if (stuckPending) warnings.push(`${stuckPending} pending job(s) older than 1h (worker down?)`);
  if (failingSources.length) {
    warnings.push(`${failingSources.length} source(s) failing: ${failingSources.slice(0, 5).map((s) => String(s.id)).join(", ")}`);
  }
  const deliveryFailures = deliveries24h[0]?.failed ?? 0;
  if (deliveryFailures > 0) warnings.push(`${deliveryFailures} failed deliveries in 24h`);

  const status: "healthy" | "degraded" | "unhealthy" =
    deliveryFailures > 20 || stuckPending > 20 ? "degraded" : warnings.length ? "degraded" : "healthy";
  if (status === "healthy") warnings.length = 0;

  return {
    status,
    checks: {
      database: { reachable: true, latencyMs: dbLatencyMs },
      scheduler: {
        counts: statuses,
        stuckPending,
        failures: failedJobs.map((j) => ({
          jobType: j.job_type,
          attempts: j.attempts,
          maxAttempts: j.max_attempts,
          lastError: j.last_error,
          updatedAt: j.updated_at,
        })),
      },
      sources: (sources as Array<Record<string, unknown>>).map((s) => ({
        id: s.id,
        enabled: s.enabled === 1,
        intervalMinutes: s.interval_minutes,
        lastRunAt: s.last_run_at,
        lastSuccessAt: s.last_success_at,
        lastError: s.last_error,
        consecutiveFailures: s.consecutive_failures,
      })),
      deliveries: {
        last24h: {
          delivered: deliveries24h[0]?.delivered ?? 0,
          failed: deliveryFailures,
        },
      },
      catalog: {
        total: catalog[0]?.total ?? 0,
        open: catalog[0]?.open ?? 0,
        closingSoon: catalog[0]?.closing_soon ?? 0,
        withDeadline: catalog[0]?.with_deadline ?? 0,
      },
      tenants: guildCount[0]?.n ?? 0,
    },
    warnings,
  };
}

/** Aggregated structured log/failure feed assembled from persisted state. */
export async function gatherLogEvents(
  db: Database,
  options: { sinceMinutes?: number; level?: "all" | "error"; limit?: number },
): Promise<LogEvent[]> {
  const minutes = Math.min(Math.max(options.sinceMinutes ?? 24 * 60, 1), 60 * 24 * 30);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);
  const levelErrorOnly = options.level === "error";
  const events: LogEvent[] = [];

  const jobs = await db.execute(
    sql`select job_type, status, attempts, max_attempts, last_error, updated_at
          from scheduled_jobs
         where updated_at > now() - (${minutes} || ' minutes')::interval
           and (status in ('failed','running') or last_error is not null or attempts > 0)
         order by updated_at desc
         limit ${limit}`,
  );
  for (const row of (jobs as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const severity = row.status === "failed" ? "error" : row.status === "running" && Number(row.attempts ?? 0) >= Number(row.max_attempts ?? 0) ? "warn" : "info";
    if (levelErrorOnly && severity !== "error") continue;
    events.push({
      ts: new Date(String(row.updated_at)).toISOString(),
      severity,
      origin: "jobs",
      message: (row.last_error as string | null) ?? `job ${row.status}`,
      context: { jobType: row.job_type, attempts: Number(row.attempts ?? 0), maxAttempts: Number(row.max_attempts ?? 0), status: row.status },
    });
  }

  const sourceRows = await db.execute(
    sql`select id, last_error, consecutive_failures, last_run_at from opportunity_sources
         where last_error is not null and coalesce(last_run_at, now()) > now() - (${minutes} || ' minutes')::interval
         order by last_run_at desc nulls last limit ${limit}`,
  );
  for (const row of (sourceRows as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const failures = Number(row.consecutive_failures ?? 0);
    const severity = failures >= 3 ? "error" : "warn";
    if (levelErrorOnly && severity !== "error") continue;
    events.push({
      ts: new Date(String(row.last_run_at ?? Date.now())).toISOString(),
      severity,
      origin: "sources",
      message: `source ${row.id}: ${row.last_error}`,
      context: { sourceId: row.id, consecutiveFailures: failures },
    });
  }

  const deliveryRows = await db.execute(
    sql`select guild_id, opportunity_id, error, delivered_at
          from opportunity_deliveries
         where failed = 1
           and delivered_at > now() - (${minutes} || ' minutes')::interval
         order by delivered_at desc
         limit ${limit}`,
  );
  for (const row of (deliveryRows as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    if (levelErrorOnly) {
      // delivery failures are always errors; keep them
    }
    events.push({
      ts: new Date(String(row.delivered_at)).toISOString(),
      severity: "error",
      origin: "deliveries",
      message: `delivery failed for opportunity ${row.opportunity_id}: ${row.error}`,
      context: { guildId: row.guild_id, opportunityId: row.opportunity_id },
    });
  }

  events.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return events.slice(0, limit);
}

export function registerIntegrationRoutes(router: Router, db: Database): void {
  router.get("/api/integrations/health", integrationGuard, async (_req: Request, res: Response) => {
    try {
      const report = await buildIntegrationReport(db);
      res.status(200).json({
        app: "orbit",
        version: "0.1.0",
        generatedAt: new Date().toISOString(),
        ...report,
      });
    } catch {
      // database unreachable: the report alone is the failure signal
      res.status(503).json({
        app: "orbit",
        status: "unhealthy",
        generatedAt: new Date().toISOString(),
        checks: { database: { reachable: false } },
      });
    }
  });

  router.get("/api/integrations/logs", integrationGuard, async (req: Request, res: Response) => {
    const level = req.query.level === "error" ? "error" : "all";
    const minutes = /^\d+$/.test(String(req.query.since_minutes ?? "")) ? Number(req.query.since_minutes) : undefined;
    const limit = /^\d+$/.test(String(req.query.limit ?? "")) ? Number(req.query.limit) : undefined;
    try {
      const events = await gatherLogEvents(db, { sinceMinutes: minutes, level, limit });
      res.status(200).json({ generatedAt: new Date().toISOString(), count: events.length, events });
    } catch {
      res.status(503).json({ error: "log query failed; database unreachable" });
    }
  });
}
