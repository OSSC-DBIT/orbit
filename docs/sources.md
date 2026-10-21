# Orbit source connectors

Six connectors feed the opportunity catalog. Docs describe behaviour; the
authoritative endpoints live next to their code in
`src/opportunities/connectors/`.
`arbeitnow` was retired in October 2026 per maintainer decision (kept
disabled in `RETIRED_SOURCES`; its listings were purged).

## Data honesty rules (all sources)

- Missing facts stay `null`; nothing is inferred or fabricated.
- `TBA`, `TBD` and empty dates become `null`.
- Undated hackathons and events already past are dropped, not archived
  with made-up dates.
- HackCulture cards carry no deadline and never will (the upstream API does
  not publish one); `is_registration_open` survives in metadata instead.
- Every record keeps its source id; deliveries and embeds show it.

## The dedup chain (why nothing repeats)

1. Exact identity: `(source_id, external_id)`.
2. Canonical URL: lowercased host, tracking parameters stripped and sorted,
   root slash preserved.
3. Normalized title + organization similarity key.
4. Cross-source merging is conservative (same category, title token
   similarity >= 0.6, and matching organization or URL host): two real
   distinct opportunities with similar names are never merged by accident.
5. Content fingerprint filters announcement-worthy changes from markdown
   churn: substantive updates repost at most once; presentation changes do
   not repost.
6. PostgreSQL unique constraint `(guild_id, opportunity_id, channel_id,
   delivery_kind)` makes delivery exactly-once even across restarts and
   workers.

## Connector catalog

| Connector id | Source | Kind | License / attribution |
| --- | --- | --- | --- |
| `jobspy` | Indeed + Naukri via bundled python-jobspy CLI | CLI pilot | python-jobspy MIT; per-board attribution on every record; boards' own terms apply to the data they serve |
| `hackathon-api` | community hackathon aggregator (0xarchit/hackathon-api) | API | MIT; attribution recorded on every record |
| `hackculture` | HackCulture API | API | public API; own terms |
| `devpost` | Devpost public listings | scrape/API | public data; conservative rate |
| `remotive` | Remotive remote jobs API | API | public API |
| `hn-hiring` | Hacker News who-is-hiring via Algolia search | API | public API |

### jobspy (pilot, India-first jobs)

- Bundled binary: the app image ships a Python venv at `/opt/jobspy` with
  `python-jobspy` 1.4.0 (MIT, pinned). The connector spawns the `jobspy` CLI;
  no sidecar container and no extra service to run.
- Boards enabled for the pilot: `indeed` + `naukri`, country `India`, window
  `hours_old 72`, `results_wanted 50` per board per pass, two passes per run
  (plain jobs + `--job-type internship`). No proxies; if a board blocks the
  host, that board reports an error upstream and exits nonzero only when
  EVERY board fails: the connector throws and the collector records health.
- Real output shapes (verified with live rows Oct 2026): `skills` is a
  comma-separated string (or list), untyped rows carry `job_type: null`,
  salary floats with `currency` and `interval` when the board publishes
  them, `date_posted` is a plain date. All mapped defensively: missing
  fields are absent from the JSON lines, never guessed.
- Jobs and internships legitimately have no deadline: `application_deadline`
  and event dates stay `null`. Attribution is per board in metadata.
- The call frequency is the standard 420 minute cadence, within each board's
  tolerance as observed the day the pilot shipped; no LinkedIn, no proxies,
  no other boards unless a maintainer changes the CLI args (pinned in code).

### hackathon-api (documented in detail)

- Upstream: `https://hackathon-api-sigma.vercel.app/api/v1/hackathons`
- Project: https://github.com/0xarchit/hackathon-api (MIT license). Orbit
  is NOT affiliated with it; Orbit calls the public API as a consumer and
  republishes attribution, not raw dumps.
- No authentication, no key. Conservative client side throttling applies
  through the shared http client (bounded retries + jitter + timeout +
  response size cap).
- Fields: name, tagline/theme, registration end date, event dates, mode
  (online/in-person/hybrid), location, prizes, eligibility, image, links.
  Dates arrive as `YYYY-MM-DD` or literal TBA strings; TBA maps to `null`.
  The connector stores deadline only when a real date exists; closing soon
  states derive from the guild timezone presentation on top of UTC instants.
- Past or undated events are dropped at ingest.
- Offline behaviour is pinned by verbatim fixtures in
  `test/unit/connectors-offline.test.ts` (schema drift in the upstream API
  fails the offline suite, which protects the mapping).

### hackculture

- Upstream: `https://api.hackculture.io/api/v1/hackathons?response_type=card&limit=50&skip=N`
- Pagination via `skip` only (cursor increment); no auth.
- No card-level deadline exists upstream: `applicationDeadline` stays null
  for this source by design; registration openness comes from
  `is_registration_open` kept in metadata.
- Same conservative merge and fingerprint rules as above.

### devpost, remotive, hn-hiring

- Public APIs documented upstream by each provider; connectors apply one
  normalization pass (text, URLs, dates) and one shared fingerprint model.
- Drop shadow filtering: listings without a usable identity (no URL, no
  title) are ignored.
- HN hiring posts keep `null` compensation unless the listing states it in
  a parseable shape; HN threads are stored with comment/context link.

## Not integrated (status: documented)

- MLH (`mlh.io`): public `events.json` currently responds with HTML, not
  JSON; no stable public API to integrate safely.
- Devfolio (`devfolio.co`): public API endpoints return 404 / require
  authenticated keys tied to specific integrations.

These are revisited when their public surfaces stabilize.

## Cadence

Per-source collection every `SYNC_INTERVAL_MINUTES` (default 420 = 7h), i.e.
3-4 collection passes/day/source; per-source overrides live in
`opportunity_sources.interval_minutes`. Health per source (last run, last
success, failure streak, last error) is visible to admins and in the
integration report. The queue mechanics behind these cadences, plus every
health probe and the failure playbook, are documented in `docs/scheduling.md`.

## Adding a new source (checklist)

1. Add `src/opportunities/connectors/<id>.ts` implementing the connector
   interface with explicit field mapping (nulls preserved).
2. Register it in the registry (`createConnector` + `ensureDefaultSources`).
3. Mirror a real upstream payload verbatim into
   `test/unit/connectors-offline.test.ts`.
4. Run `npm run test:unit`; then the full suite with a throwaway Postgres.
5. Document the upstream terms/licence in this file.
