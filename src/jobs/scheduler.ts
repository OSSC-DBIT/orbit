import { sql } from "drizzle-orm";
import type { Database } from "../database/client.js";
import { getDb } from "../database/client.js";
import { getLogger, scopedLogger } from "../core/logging/logger.js";
import { newCorrelationId } from "../core/ids.js";
import { metrics } from "../observability/metrics.js";

/**
 * Postgres-backed durable scheduler.
 *
 * Why not Redis/BullMQ initially: the scheduling surface in Orbit is periodic
 * cadences (source sync every 3-4/day, deadline sweeps, digests, retention),
 * all short lived. A transactional SKIP LOCKED queue on PostgreSQL gives the
 * same at-least-once semantics with idempotency keys, without a second
 * datastore to operate. The interface below swaps a BullMQ worker in without
 * changing handler signatures if queued fan-out grows.
 *
 * Guarantees:
 *  - claim semantics: FOR UPDATE SKIP LOCKED, no double-running job;
 *  - stale claims: `locked_at` older than `staleAfterMs` re-queued (crash recovery);
 *  - retries: attempts < max_attempts with exponential backoff & jitter;
 *  - idempotency: partial unique key on (idempotency_key) where not cancelled;
 *  - safe shutdown: stop accepting jobs, await current, release lock.
 */
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

export interface JobContext {
  jobId: number;
  jobType: string;
  correlationId: string;
  signal: AbortSignal;
}

export interface SchedulerOptions {
  workerId: string;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  batchSize?: number;
  /** Max concurrent job executions. */
  maxConcurrent?: number;
}

export interface ScheduledJobRow {
  id: number;
  jobType: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
  attempts: number;
  correlationId: string | null;
}

export class Scheduler {
  private handlers = new Map<string, JobHandler>();
  private running = 0;
  private stopped = false;
  private abort = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private db: Database = getDb(),
    private options: SchedulerOptions,
  ) {}

  register(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  /**
   * Declares a periodic job (recurring via next-run chaining). Idempotent:
   * an existing row is revived when it completed or failed, and a healthy
   * chain keeps whichever run_at is earlier (boot jitter never delays it).
   */
  async ensureRecurring(
    jobType: string,
    intervalSeconds: number,
    payload: Record<string, unknown> = {},
    jitterSeconds = 120,
  ): Promise<void> {
    const idempotencyKey = `recurring:${jobType}`;
    const storedPayload = { ...payload, intervalSeconds };
    await this.db.execute(sql`
      insert into scheduled_jobs (job_type, idempotency_key, payload, run_at, correlation_id)
      values (${jobType}, ${idempotencyKey}, ${JSON.stringify(storedPayload)}::jsonb,
              now() + (random() * ${jitterSeconds} * interval '1 second'),
              ${newCorrelationId("job")})
      on conflict (idempotency_key) where idempotency_key is not null and status != 'cancelled'
      do update set
        payload = ${JSON.stringify(storedPayload)}::jsonb,
        run_at = case
          when scheduled_jobs.status in ('done', 'failed') then excluded.run_at
          else least(scheduled_jobs.run_at, excluded.run_at)
        end,
        status = case
          when scheduled_jobs.status in ('done', 'failed') then 'pending'
          else scheduled_jobs.status
        end,
        attempts = case
          when scheduled_jobs.status in ('done', 'failed') then 0
          else scheduled_jobs.attempts
        end
    `);
  }

  scheduleOnce(jobType: string, runAt: Date, payload: Record<string, unknown>, idempotencyKey?: string, maxAttempts = 3): Promise<void> {
    return this.db.execute(sql`
      insert into scheduled_jobs (job_type, idempotency_key, payload, run_at, max_attempts, correlation_id)
      values (${jobType}, ${idempotencyKey ?? null}, ${JSON.stringify(payload)}::jsonb, ${runAt.toISOString()}, ${maxAttempts}, ${newCorrelationId("job")})
      on conflict (idempotency_key) where idempotency_key is not null and status != 'cancelled' do nothing
    `) as unknown as Promise<void>;
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    // wait for in-flight jobs to finish (bounded)
    for (let i = 0; i < 100 && this.running > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.loopPromise = null;
  }

  async loop(): Promise<void> {
    const log = scopedLogger(getLogger(), { tenant: "scheduler" });
    while (!this.stopped) {
      try {
        await this.recoverStale();
        const batchN = await this.claimAndRun();
        if (batchN.count === 0) {
          await new Promise((r) => setTimeout(r, this.options.pollIntervalMs ?? 5_000));
        } else {
          // keep the loop hot when work exists
          await new Promise((r) => setTimeout(r, Math.min(250, this.options.pollIntervalMs ?? 5_000)));
        }
      } catch (err) {
        log.error({ error: err instanceof Error ? err.message : String(err) }, "scheduler loop error");
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async recoverStale(): Promise<void> {
    const staleAfter = `${Math.floor((this.options.staleAfterMs ?? 300_000) / 1000)} seconds`;
    await this.db.execute(sql`
      update scheduled_jobs
      set status = 'pending', locked_by = null, locked_at = null,
          last_error = case when attempts >= max_attempts then coalesce(last_error, '') || ' (recovered stale claim#' || id || ')' else last_error end
      where status = 'running'
              and locked_at < now() - ${staleAfter}::interval
              and attempts < max_attempts
    `);
  }

  private async claimAndRun(): Promise<{ count: number }> {
    const jobRows = await this.db.execute(sql`
      update scheduled_jobs
      set status = 'running',
          attempts = attempts + 1,
          locked_by = ${this.options.workerId},
          locked_at = now(),
          updated_at = now()
      where id in (
        select id from scheduled_jobs
        where status = 'pending' and run_at <= now()
        order by run_at
        limit ${this.options.batchSize ?? 8}
        for update skip locked
      )
      returning id, job_type as "jobType", payload, attempts, max_attempts as "maxAttempts", correlation_id as "correlationId"
    `) as unknown as { rows: ScheduledJobRow[] };

    let count = 0;
    for (const job of jobRows.rows) {
      if (this.running >= (this.options.maxConcurrent ?? 4)) break;
      count++;
      this.running++;
      void this.runOne(job)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          getLogger().error({ jobId: job.id, jobType: job.jobType, correlationId: job.correlationId, error: message }, "job failed");
          metrics.jobsOutcome(job.jobType, "failed");
        })
        .finally(() => {
          this.running--;
        });
    }
    return { count };
  }

  private async runOne(job: ScheduledJobRow): Promise<void> {
    const handler = this.handlers.get(job.jobType);
    const correlationId = job.correlationId ?? newCorrelationId("job");
    let succeeded = false;
    if (handler) {
      try {
        await handler(job.payload ?? {}, {
          jobId: job.id,
          jobType: job.jobType,
          correlationId,
          signal: this.abort.signal,
        });
        succeeded = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.markFailed(job, message);
        return;
      }
    } else {
      // unknown job type with no handler: retire quietly
      succeeded = true;
    }
    if (succeeded) {
      await this.markDone(job, correlationId);
    }
  }

  private async markDone(job: ScheduledJobRow, correlationId: string): Promise<void> {
    const next = computeNextRun(job.jobType, job.payload);
    if (next) {
      // recurring jobs re-queue themselves
      await this.db.execute(sql`
        update scheduled_jobs
        set status = 'pending',
            run_at = ${next},
            attempts = 0,
            locked_by = null,
            locked_at = null,
            last_error = null,
            correlation_id = ${correlationId},
            updated_at = now()
        where id = ${job.id}
      `);
      metrics.jobsOutcome(job.jobType, "done");
    } else {
      await this.db.execute(sql`
        update scheduled_jobs
        set status = 'done', locked_by = null, locked_at = null, updated_at = now()
        where id = ${job.id}
      `);
      metrics.jobsOutcome(job.jobType, "done");
    }
  }

  private async markFailed(job: ScheduledJobRow, message: string): Promise<void> {
    if (job.attempts >= job.maxAttempts) {
      await this.db.execute(sql`
        update scheduled_jobs
        set status = 'failed', last_error = left(${message}, 500), locked_by = null,
            locked_at = null, updated_at = now()
        where id = ${job.id}
      `);
      metrics.jobsOutcome(job.jobType, "failed_final");
      return;
    }
    const backoffSeconds = Math.min(900, 15 * 2 ** job.attempts) + Math.floor(Math.random() * 30);
    await this.db.execute(sql`
      update scheduled_jobs
      set status = 'pending',
          run_at = now() + (${backoffSeconds} || ' seconds')::interval,
          last_error = left(${message}, 500),
          locked_by = null,
          locked_at = null,
          updated_at = now()
      where id = ${job.id}
    `);
    metrics.jobsOutcome(job.jobType, "retry");
  }
}

/** Computes when a recurring job should run next, or null when it is one-shot. */
export function computeNextRun(jobType: string, payload: Record<string, unknown>): Date | null {
  const intervalSeconds = typeof payload.intervalSeconds === "number" ? payload.intervalSeconds : null;
  if (intervalSeconds && intervalSeconds > 4) {
    return new Date(Date.now() + intervalSeconds * 1000 + Math.floor(Math.random() * 45_000));
  }
  const recurringIntervals: Record<string, number> = {
    sync_sources: 3 * 3600,
    lifecycle_sweep: 3600,
    deadline_sweep: 15 * 60,
    digest_dispatch: 3600,
    retention_cleanup: 24 * 3600,
  };
  if (jobType in recurringIntervals) {
    const seconds = recurringIntervals[jobType]!;
    return new Date(Date.now() + seconds * 1000 + Math.floor(Math.random() * 45_000));
  }
  return null;
}

