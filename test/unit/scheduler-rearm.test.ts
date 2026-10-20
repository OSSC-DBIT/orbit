import { describe, expect, it } from "vitest";
import { computeNextRun } from "../../src/jobs/scheduler.js";

/**
 * Offline unit coverage for the recurring re-arm policy. The full chain
 * (claim, run, re-arm against PostgreSQL) is covered by
 * test/integration/scheduler-rearm.test.ts.
 */
describe("scheduler: recurring re-arm policy", () => {
  it("re-arms known recurring job types even when payload lacks intervalSeconds", () => {
    const before = Date.now();
    const next = computeNextRun("sync_sources", {});
    expect(next).toBeInstanceOf(Date);
    const delta = (next as Date).getTime() - before;
    // sync_sources re-arms at ~3h plus a small completion jitter
    expect(delta).toBeGreaterThan(3 * 3_600 * 1_000 - 1_000);
    expect(delta).toBeLessThanOrEqual(3 * 3_600 * 1_000 + 45_000);
  });

  it("prefers payload.intervalSeconds over the built-in cadence map", () => {
    const before = Date.now();
    const next = computeNextRun("anything_else", { intervalSeconds: 60 });
    expect(next).toBeInstanceOf(Date);
    const delta = (next as Date).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(59_000);
    expect(delta).toBeLessThanOrEqual(60_000 + 45_000);
  });

  it("leaves one-shot job types unre-armed", () => {
    expect(computeNextRun("unknown_job", {})).toBeNull();
  });
});
