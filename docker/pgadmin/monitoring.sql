-- Orbit staging: visual monitoring starter for pgAdmin.
-- Open in pgAdmin: Tools > Query Tool > Open File, pick this file, run
-- one block at a time (they are numbered). Timestamps render in IST,
-- which matches the timezone Orbit runs on.
--
-- NOTE: rows carry no guild scoping unless the session defines it, so you
-- see the same system-wide view the running app has.

-- 0) Quick verdict: is the original DB healthy? Run this one first. Every
--    line should read ok/green; anything not ok needs the app logs checked.
SELECT 'opportunities fresh last 24h' AS check,
       case when (select count(*) from opportunities where last_seen_at > now() - interval '24 hours') > 0
            then 'ok' else 'NOT ok' end AS state,
       (select count(*)::text from opportunities) AS detail
UNION ALL
SELECT 'sources reporting', 'ok', count(*)::text
FROM opportunity_sources
WHERE consecutive_failures = 0
UNION ALL
SELECT 'failed scheduled jobs', 'ok', count(*)::text
FROM scheduled_jobs
WHERE status IN ('failed', 'cancelled')
UNION ALL
SELECT 'pending scheduled jobs', 'ok', count(*)::text
FROM scheduled_jobs
WHERE status = 'pending'
UNION ALL
SELECT 'migrations applied', 'ok', count(*)::text
FROM _orbit_migrations
UNION ALL
SELECT 'github webhook deliveries', 'info (awaiting app install)', count(*)::text
FROM github_webhook_deliveries;

-- 1) Source scoreboard: how many rows each source has, their live state
--    and when the collector last touched it.
--
--    healthy = every source has rows with last_seen_at from today (IST)
SELECT source_id,
       status,
       count(*) AS rows,
       max(last_seen_at) AT TIME ZONE 'Asia/Kolkata' AS last_seen_ist
FROM opportunities
GROUP BY source_id, status
ORDER BY source_id, status;

-- 2) Freshness guard: nothing should be older than one day. If a source
--    shows STALE here, its sync job is silently failing (check app logs).
SELECT source_id,
       count(*) FILTER (WHERE last_seen_at > now() - interval '24 hours') AS fresh_24h,
       count(*) AS total,
       CASE WHEN count(*) FILTER (WHERE last_seen_at > now() - interval '24 hours') = 0
            THEN 'STALE' ELSE 'ok' END AS verdict
FROM opportunities
GROUP BY source_id
ORDER BY source_id;

-- 3) Closing soon: what the deadline scheduler is about to fire for.
SELECT title, category,
       closing_soon_at AT TIME ZONE 'Asia/Kolkata' AS closes_ist,
       application_url
FROM opportunities
WHERE closing_soon_at IS NOT NULL
  AND closing_soon_at > now()
ORDER BY closing_soon_at
LIMIT 25;

-- 4) Upcoming event starts (next 30 days), so ongoing/future windows
--    stay sensible for the listings UX.
SELECT title, category, source_id,
       event_starts_at AT TIME ZONE 'Asia/Kolkata' AS starts_ist,
       event_ends_at AT TIME ZONE 'Asia/Kolkata' AS ends_ist
FROM opportunities
WHERE event_starts_at IS NOT NULL
  AND event_starts_at BETWEEN now() AND now() + interval '30 days'
ORDER BY event_starts_at
LIMIT 25;

-- 5) Delivery health per guild: total, failures, last push.
SELECT guild_id,
       count(*) AS deliveries,
       count(*) FILTER (WHERE coalesce(failed, 0) > 0) AS failed,
       max(delivered_at) AT TIME ZONE 'Asia/Kolkata' AS last_delivery_ist
FROM opportunity_deliveries
GROUP BY guild_id
ORDER BY deliveries DESC
LIMIT 25;

-- 6) GitHub webhook trail: recent deliveries and any errors. Zero rows
--    here means no app install received or webhook not yet reachable.
SELECT event_type, repository_full_name, status,
       received_at AT TIME ZONE 'Asia/Kolkata' AS received_ist,
       left(coalesce(error, ''), 60) AS error_head
FROM github_webhook_deliveries
ORDER BY received_at DESC
LIMIT 20;

-- 7) Scheduled job queue: pending vs terminal states, and who is next.
SELECT job_type, status, count(*) AS jobs,
       min(run_at) AT TIME ZONE 'Asia/Kolkata' AS next_run_ist
FROM scheduled_jobs
GROUP BY job_type, status
ORDER BY job_type, status;

-- 8) Table sizes: where the disk grows.
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size('public.' || relname)) AS total_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size('public.' || relname) DESC
LIMIT 10;
