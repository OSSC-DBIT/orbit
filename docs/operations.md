# Orbit operations runbook

Day-2 operations. Setup lives in `docs/production-guide.md`, machine prep in
`docs/deployment.md`.

## 1. Health surfaces

| Surface | Auth | Use |
| --- | --- | --- |
| `/healthz` | public | process liveness (compose healthcheck) |
| `/readyz` | public | readiness incl. database ping |
| `/metrics` | admin bearer (or local) | Prometheus text exposition |
| `/api/admin/sources` | admin bearer | source registry state |
| `/api/admin/jobs/failures` | admin bearer | recent scheduler failures |
| `/api/integrations/health` | integration bearer | full machine readable report |
| `/api/integrations/logs` | integration bearer | structured event feed |

Both bearer tokens come from `ADMIN_API_TOKEN` and `INTEGRATION_API_TOKEN`;
a missing integration token disables those routes (503) rather than opening
them.

## 2. The integration report

`GET /api/integrations/health` returns one JSON object your own tooling can
poll:

```bash
curl -s -H "Authorization: Bearer $ORBIT_TOKEN" \
  https://orbit.example.com/api/integrations/health | jq .
```

Interpreting the fields:

- `status`: `healthy` / `degraded` / `unhealthy`
- `checks.database`: reachable flag and last ping latency in ms
- `checks.scheduler.counts`: live queue histogram; `stuckPending` should
  stay near 0 (stale running rows recover automatically)
- `checks.sources[]`: per source `lastRunAt`, `lastSuccessAt`, `lastError`,
  `consecutiveFailures`; a growing failure streak means the upstream API is
  degraded or egress is blocked
- `checks.deliveries.last24h`: delivered vs failed message outcomes
- `checks.webhooks.last24hByStatus`: GitHub webhook outcome histogram
- `checks.catalog`: opportunity totals (open, closingSoon, withDeadline)
- `warnings[]`: non fatal observations (e.g. a source with a failure streak)

`GET /api/integrations/logs?since_minutes=&level=&limit=` (limit capped at
300) returns timestamped events from jobs, sources, deliveries and webhooks;
it reads persisted state, never raw stdout, so it survives log rotation.

## 3. Scheduler

Jobs live in `scheduled_jobs`. Normal cadence:

| Job | Interval | Does |
| --- | --- | --- |
| `sync_sources` | parent cadence (by default every 420 min; per source `interval_minutes` also applies) | collects due sources, dedupes, fans out fresh listings |
| `lifecycle_sweep` | hourly | closes past deadlines, ages listings |
| `deadline_sweep` | 15 min | sends due deadline reminder rows |
| `digest_dispatch` | hourly | dispatches digests when a guild's local hour matches `digest_hours` (IST default window) |
| `retention_cleanup` | daily | prunes old event and job rows (`RETENTION_DAYS`) |

Inspect the queue (host side):

```bash
docker compose exec postgres psql -U postgres -d orbit -c \
  "select job_type, status, attempts, run_at, last_error from scheduled_jobs order by run_at limit 20;"
```

A recurring row that ends `done` and never goes `pending` again is a dead
chain (fixed in current code by a claim-mapping regression test); the
integration suite covers it (`scheduler-rearm.test.ts`).

## 4. Logs

Structured JSON on stdout only (`docker compose logs app`). Pino redaction
scrubs credential shaped strings. Levels by env: `LOG_LEVEL=debug` for
verbose, `info` normal, `warn` on recoverables (e.g. Discord login retry is
warn on purpose: the HTTP plane stays up while the gateway reconnects).

## 5. Common incidents

| Situation | Runbook |
| --- | --- |
| integrations report `unhealthy` (db unreachable) | `docker compose ps` postgres; restart; check disk full |
| `degraded` with source failure streaks | read `lastError`; if upstream API died, mark the source disabled in `opportunity_sources` and investigate; Orbit keeps running with the remaining sources |
| webhook deliveries all `fail` | verify tunnel up: `docker compose logs tunnel`; secret mismatch gives 401 and GitHub retries |
| digest never fires | guild timezone set to UTC means "not configured" (falls back to deploy default); check `digest_hours` and the digest channel binding |
| too many posts per channel | lower quota via guild preferences; deliveries are quota capped daily and deduplicated per (channel, kind) |
| AI suddenly absent | quota exhausted or provider down by design; product degrades without error spam |

## 6. Database hygiene

- `VACUUM (ANALYZE)` nightly is handled by autovacuum defaults; no cron.
- Restore drill: practice the restore path in staging quarterly.
- Rotating `APP_ENCRYPTION_KEY` requires re-encrypting stored secrets;
  treat it like a break-glass action.

## 7. Capacity notes

- Single node by design; the scheduler uses `FOR UPDATE SKIP LOCKED` claims
  so a second app pod would be safe to add, but MongoDB-style multi host is
  not targeted yet.
- Pool is fixed at 10 connections; if you see connection exhaustion, check
  for long transactions (delivery claims hold a transaction across the
  Discord send by design).
