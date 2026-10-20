import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { runMigrations } from "../../src/database/migrate.js";
import { getDb, closeDb } from "../../src/database/client.js";
import { Scheduler } from "../../src/jobs/scheduler.js";

/**
 * Database integration test: the recurring job chain must re-arm itself
 * after every run. Regression for the claim row mapping bug that marked
 * every recurring job `done` on first completion (silent dead chains).
 */

const ORBIT_TEST_DATABASE_URL = process.env.ORBIT_TEST_DATABASE_URL ?? null;
const d = ORBIT_TEST_DATABASE_URL ? describe : describe.skip;

interface JobRow {
  status: string;
  run_at: Date | string;
  attempts: number;
}

d("database: scheduler recurring chain", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = ORBIT_TEST_DATABASE_URL!;
    await runMigrations();
  }, 120_000);

  afterAll(async () => {
    await closeDb();
  });

  it("re-arms a recurring job after it runs (no dead chains)", async () => {
    const db = getDb();
    const scheduler = new Scheduler(db, {
      workerId: `rearm-test-${Date.now().toString(36)}`,
      pollIntervalMs: 200,
      batchSize: 4,
      maxConcurrent: 2,
      staleAfterMs: 60_000,
    });
    scheduler.register("sync_sources", async () => {});

    // Fresh insert or revival of a previously completed chain row, then
    // force the row due so the run happens right now.
    await scheduler.ensureRecurring("sync_sources", 3 * 3_600, { intervalSeconds: 3 * 3_600 });
    await db.execute(sql`
      update scheduled_jobs
      set status = 'pending', run_at = now() - interval '1 second',
          attempts = 0, locked_by = null, locked_at = null
      where idempotency_key = 'recurring:sync_sources'
    `);

    scheduler.start();
    try {
      const deadline = Date.now() + 30_000;
      let row: JobRow | undefined;
      while (Date.now() < deadline) {
        const res = await db.execute(sql`
          select status, run_at, attempts
          from scheduled_jobs
          where idempotency_key = 'recurring:sync_sources'
          limit 1
        `) as unknown as { rows: JobRow[] };
        row = res.rows[0];
        // re-armed means: pending again, scheduled in the future (~3h)
        if (row?.status === "pending" && new Date(row.run_at).getTime() > Date.now() + 60_000) break;
        await new Promise((r) => setTimeout(r, 400));
      }

      expect(row?.status).toBe("pending");
      expect(new Date(row!.run_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
      expect(row?.attempts).toBe(0);
    } finally {
      await scheduler.stop();
    }
  }, 60_000);
});
