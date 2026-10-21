# Changelog

All notable changes to Orbit are documented here. Dates are DD.MM.YYYY.

## 21.10.2026

### Added

- Project monitoring, push based: guilds register a project, get a bearer
  ingest token, and push events or heartbeats from their own apps. A stale
  watchdog (`infra_sweep`, every 15 minutes) announces outages in the bound
  channel and announces recovery on the next heartbeat.
- `/project` admin command family: `add`, `list`, `remove`, `token`,
  `channel`, `test`.
- Ingest API: `POST /api/projects/:id/events` and
  `POST /api/projects/:id/heartbeat`, bearer token auth, 30 requests per
  minute per project, fail closed on missing or invalid token, events always
  stored even when announcing is impossible.
- Per category channel splits: `hackathons`, `jobs`, `internships` can bind
  their own channels; the `opportunities` binding stays the catch all
  fallback for every other category.
- `/status` now lists registered project monitors with live status and bound
  channel.

### Fixed

- `/channels` and `/features` dropdown choices are derived from the
  canonical constants; the new hackathons/jobs/internships kinds were
  previously invisible in Discord.
- Admin triggered source sync (`POST /api/admin/sources/:id/sync`) now runs
  the full path (source claim, collect, instant fanout), the same as the
  hourly job. Previously, manually synced listings were stored but never
  delivered.

### Changed

- Docs consolidated from 11 files to 8: `deployment.md` and
  `production-guide.md` merged into `operations.md`; `cadence.md` folded
  into `scheduling.md` (delivery rule and per source tuning recipe kept).
- Tenant daily delivery cap remains in force; raised per guild during
  staging backfill verification and should be pinned down for production.
