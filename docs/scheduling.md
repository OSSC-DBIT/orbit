# Scheduling, jobs and health

How Orbit's "cron" works, what jobs exist, every way to observe their health,
and what to do when something is stuck. Code references are exact: the
authoritative sources are `src/jobs/scheduler.ts` and `src/jobs/handlers.ts`.

## 1. The model: a Postgres-backed scheduler, not a cron binary

There is no OS crontab and no Redis. The Node app runs one in-process loop
(`Scheduler.start()`) that polls a durable queue table `scheduled_jobs` in
Postgres. The single app container is the only worker.

Why this shape: Orbit's workload is a few short periodic cadences (source
syncs several times a day, deadline sweeps every few minutes, daily
digests, retention cleanup). A transactional SKIP LOCKED queue on Postgres
gives at-least-once runs with retries and crash recovery, without a second
datastore to operate.

Guarantees, straight from the implementation:

- Claim semantics: rows are claimed with `FOR UPDATE SKIP LOCKED`, so no two
  workers (and no restart) ever double-run one job.
- Stale claims: a claim (`locked_at`) older than 5 minutes is re-armed to
  `pending`; last_error gets the marker `(recovered stale claim#<id>)`.
- Retries: `attempts < max_attempts` (3 by default) with exponential backoff:
  15 * 2^attempts seconds, capped at 900 seconds, plus 0 to 30 seconds of
  jitter. Past the cap the row goes to `failed`.
- Idempotency: partial unique index on `idempotency_key` (only rows whose
  status is not `cancelled` participate). Recurring rows are keyed
  `recurring:<job_type>`, so restarts and concurrent boots converge on one
  chain instead of creating duplicates.
- Safe shutdown: `stop()` aborts in-flight handlers and drains up to 10
  seconds before exit.

Loop mechanics: poll every 5 seconds when idle; hot loop (250 ms) when work
exists; claim up to 8 jobs per pass; run at most 4 concurrently.

## 2. The job catalog

Recurring jobs are declared at boot in `recurringIntervals()` and kept alive
by `ensureRecurring()`. If a chain row somehow completed or failed, the next
boot revives it; while healthy, the earlier of (existing run_at, freshly
computed run_at) wins, so boot jitter never delays a job.

| Job type | Does | Cadence |
| --- | --- | --- |
| `sync_sources` | one pass over enabled sources: connectors who are due (per-source `interval_minutes`, default 420) run in sync-priority order, listings dedupe and fan out | parent chain every 3 hours |
| `lifecycle_sweep` | expires or closes past listings (none stays stale in the catalog) | every hour |
| `deadline_sweep` | materializes per-tenant deadline reminders and sends ones that fall due (reminder offsets default 72h / 24h / 6h) | every 15 minutes |
| `digest_dispatch` | sends the daily digest to a guild when its local hour matches its `digest_hours` (guild timezone, IST by default) | checks every hour |
| `retention_cleanup` | purges webhook deliveries, project events and audit logs older than 60 days | every 24 hours |

Non-recurring rows: one-shots via `scheduleOnce()` (idempotency key passed by
the caller), for example deadline reminder inserts. Admin sync endpoints run
their source immediately and do not go through the queue.

Per-source cadence inside `sync_sources`: a source runs only when
`now - last_run_at >= interval_minutes`. The claim itself is guarded in SQL
(`last_run_at < now() - 65 seconds`), so even manual admin triggers racing a
scheduled pass cannot double-run one source.

Source priority order lives in `SOURCE_SYNC_PRIORITY`
(`jobspy`, `hackculture`, `hackathon-api`, `devpost`, `remotive`,
`hn-hiring`). It is enforced as the SQL `order by` of the sync pass: earlier
sources claim canonical ownership of shared listings (the content
fingerprint has an insert-once rule; later sources only add bookkeeping).

No-repetition guarantee for deliveries (why restarts never spam Discord):

1. Content fingerprint: an unchanged listing is never announced again.
2. Deliveries unique index `(guild_id, opportunity_id, channel_id,
   delivery_kind)`: replays, restarts and concurrent workers cannot post
   twice.
3. Per-tenant daily volume cap on top.

## 3. Lifecycle of one row in scheduled_jobs

```
pending  queued, rescheduled for the future (run_at decides)
running  claimed: attempts+1, locked_by, locked_at set
pending  failed attempt, backoff rescheduled
failed   attempts exhausted (max_attempts = 3 by default)
done     one-shot job finished
```

Recurring rows never reach `done` while healthy: on success they re-queue
themselves as `pending` with `run_at = now + intervalSeconds (+0 to 45 s
jitter)` and `attempts = 0`.

Retry backoff (from the code, attempt numbering starts at 1):

| attempt | wait before next run |
| --- | --- |
| 1 | 30 to 60 s |
| 2 | 60 to 90 s |
| 3 | 120 to 150 s |
| n | 15 * 2^n capped at 900 s |

## 4. Observing health

Three layers: HTTP health, Prometheus-style metrics, logs. On top of those,
SQL (pgAdmin) is always available because everything is a plain table.

### 4.1 HTTP: the health endpoints

Liveness (no token):

```
curl -s http://127.0.0.1:3000/healthz
```

Full report (from outside the box: `https://orbit-staging.webuildnow.in/api/integrations/health`):

```
curl -s http://127.0.0.1:3000/api/integrations/health
```

The JSON document contains: db latency, the `scheduled_jobs` breakdown by
status, the last 20 failed jobs (one row per: job_type, attempts,
max_attempts, last_error, updated_at), a stuck-pending count
(`pending` with `run_at` older than 1 h: the "worker is down" signal),
per-source health (enabled, interval_minutes, last_run_at, last_success_at,
last_error, consecutive_failures), 24 h delivery counts, 24 h webhook
statuses, catalog totals and the active guild count.

Status derivation (also in `buildIntegrationReport`):

- `degraded` immediately if more than 20 failed deliveries in 24 h or more
  than 20 stuck pending jobs.
- otherwise `degraded` with a human warning for: any failed job, any stuck
  pending, any source failing with zero successes so far, webhook errors in
  24 h, delivery failures in 24 h.
- `healthy` clears the warnings list (it is for alarms, not history).

Last 20 failed jobs without the full report:

```
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  http://127.0.0.1:3000/api/admin/jobs/failures
```

### 4.2 Metrics

`/metrics` validates the caller first: with `ADMIN_API_TOKEN` set it
requires the bearer token; without it, loopback only. It outputs the
Prometheus text exposition (counters and gauges incl. `orbit_process_up`).

```
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" http://127.0.0.1:3000/metrics
```

Interesting counters land there automatically: job outcomes
(done/retry/failed/failed_final per job type), source runs (ok/error),
deliveries by kind, webhook events processed.

### 4.3 Logs (pino, one JSON line per event)

Boot:

```
docker logs orbit-app-1 2>&1 | Select-String "discord ready|slash"
```

Every scheduler event carries a `correlationId`; the sync pass attaches the
same id to every source inside one run:

```
docker logs orbit-app-1 2>&1 --since 30m | Select-String "source synced|job failed|scheduler loop error"
```

Line shapes you will actually see:

- `{"tenant":"sync","sourceId":"jobspy","fetched":185,"created":185, ...  "msg":"source synced"}` per source per pass
- `{"jobId":123,"jobType":"sync_sources","correlationId":"job_...","error":"...","msg":"job failed"}` when a handler throws
- `{"tenant":"scheduler","msg":"scheduler loop error"}` when the loop itself
  had a bad tick (DB blip); it self-recovers every 5 seconds
- `(recovered stale claim#<id>)` inside `last_error` marks a crashed claim
  that was re-armed at boot

### 4.4 SQL: scheduler health in pgAdmin

A ready one-glance query for the Query Tool (also matches Incidents):

```sql
-- status of the five recurring chains: healthy = every recurring row
-- is 'pending' with a run_at in the near future
select job_type,
       status,
       count(*) as rows,
       max(run_at) at time zone 'Asia/Kolkata' as next_run_ist,
       max(updated_at) at time zone 'Asia/Kolkata' as last_touched_ist
from scheduled_jobs
where idempotency_key like 'recurring:%'
group by job_type, status
order by job_type, status;
```

Failing-or-waiting evidence:

```sql
-- stuck queue: worker down if any pending row is this old
select job_type, count(*) from scheduled_jobs
where status = 'pending' and run_at < now() - interval '1 hour'
group by 1;

-- last errors per recurring chain (retries say 'pending', exhausted say 'failed')
select job_type, status, attempts, max_attempts,
       left(last_error, 160) as error,
       updated_at at time zone 'Asia/Kolkata' as ist
from scheduled_jobs
where idempotency_key like 'recurring:%' and last_error is not null
  and updated_at > now() - interval '24 hours'
order by updated_at desc;
```

`docker/pgadmin/monitoring.sql` block 7 (job queue overview) and block 0
(quick verdict) cover the daily glance.

## 5. Failure playbook

| Symptom | Likely cause and action |
| --- | --- |
| report says `pending job(s) older than 1h (worker down?)` | app container dead or wedged: check `docker compose ps`, `docker logs orbit-app-1` then restart |
| recurring chain shows `failed` | attempts ran out; fix the logged error cause; the chain self-revives on next boot (or flip `status='pending', attempts=0` in SQL if you want it now) |
| one source fails every pass | the source is failing closed: everything else keeps working; check its `last_error` in sources health and the connector docs; retired sources stay enabled=0 |
| `(recovered stale claim#N)` appears | a crash or kill happened mid-run; the row was re-armed automatically; re-check the outcome once, no action needed |
| `stuck > 0` but DB fine | check for a long-running handler (sync pass can take a minute with slow sources); the sticky marker only warns past 1 h |

Self-healing behaviours to remember: stale claims recover themselves; the
loop retries its own ticks; recurring rows revive at boot; retries back off
and eventually park in `failed` (visible, never silent).

## 6. Maintenance recipes

Force a source sync right now (direct, not queued):

```
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  http://127.0.0.1:3000/api/admin/sources/jobspy/sync
```

Change one source's cadence from SQL (no code):
`update opportunity_sources set interval_minutes = 240 where id = 'jobspy';`

Backdate a chain if you need an out-of-band run:

```sql
update scheduled_jobs
set status = 'pending', run_at = now(), attempts = 0
where job_type = 'sync_sources' and idempotency_key = 'recurring:sync_sources';
```

## 7. Where things live

| Path | Role |
| --- | --- |
| `src/jobs/scheduler.ts` | the loop, claims, retries, backoff, stale recovery |
| `src/jobs/handlers.ts` | the five handlers, tenant filtering, digest hours, retention |
| `src/jobs/digest-cal.ts` | local-hour digest matching (guild timezone) |
| `scheduled_jobs` table | the queue itself (see `src/database/schema`) |
| `src/api/integrations.ts` | the health report builder |
| `src/api/server.ts` | `/healthz`, `/metrics`, `/api/admin/jobs/failures` |
| `src/observability/metrics.ts` | counters and gauges behind `/metrics` |
| `docker/pgadmin/monitoring.sql` | SQL blocks for the daily glance |
