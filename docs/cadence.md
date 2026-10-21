# Automatic delivery cadence

Opportunities (hackathons, internships, jobs) are delivered automatically,
on an hourly check, with no repetition.

## How it works

1. A parent `sync_sources` job runs **every hour** (`scheduled_jobs`, SKIP
   LOCKED claimed, self re-arming).
2. In each pass, a source connector runs only when it is **due**: per-source
   `interval_minutes` (hourly by default, stored per row in
   `opportunity_sources`, tunable per source without code changes).
3. Anything the collector finds is deduped upstream of posting:
   - `(source_id, external_id)` exact source identity (JobSpy builds it from
     site + url + title),
   - canonicalized URL key, normalized title + org match likeness,
   - per-listing content fingerprint: presentation-only changes never post.
4. Delivery claims are unique per `(guild, opportunity, channel, delivery
   kind)` in `opportunity_deliveries`, so a listing is announced **once** per
   channel, ever, across restarts.

## The rule you care about

- New opportunity found during the hourly pass -> posted to the guild's
  `opportunities` channel immediately.
- Nothing new found -> the pass updates freshness state only and posts
  nothing. There is no hourly "still here" spam by design.
- Deadlines and digests are separate surfaces with their own tiles
  (deadline_sweep 15 min, digest_dispatch once per configured hour) and
  the same one-time delivery claims.

## Changing cadence per source

```bash
docker compose exec postgres psql -U postgres -d orbit -c \
  "update opportunity_sources set interval_minutes = 60 where id = 'jobspy';"
```

Defaults ship hourly (`DEFAULT_SOURCE_INTERVAL_MINUTES = 60` in
`src/opportunities/connectors/base.ts`). A source board can tolerate less
frequency, not more: if a board is throttling you, raise that row's
`interval_minutes` rather than the global default.
