# Orbit architecture

## Component map

```
                        ┌────────────────────────── one process (src/index.ts) ──────────────────┐
 Discord Gateway  ───►  │ bot/client.ts ─► interaction dispatch ─► commands (core/config/       │
                        │                                        opportunities) ─►             │
                        │                                        TenantService (RLS scoped)    │
 API :3000        ───►  │ api/server.ts  /healthz /readyz /metrics                  │
                        │                /api/admin/* /api/integrations/*                        │
                        └───────────────┬──────────────────────────────────────┬─────────────────┘
                                        │                                      │
                        jobs/scheduler.ts (Postgres backed, SKIP LOCKED)       │
                                        │                                      ▼
                        jobs/handlers.ts ─► collectors ─► dedup chain ─► delivery engine
                                                   │                        │
                                                   ▼                        ▼
                                          PostgreSQL 16 (Drizzle)    Discord REST (fixation via resolvers)
```

## Runtime shape

A single Node process hosts all planes of the system:

1. Discord gateway: slash commands and interaction events.
2. HTTP plane (Express): health, metrics, admin API (bearer token), external
   integration API (bearer token).
3. Job plane: a Postgres backed scheduler using `FOR UPDATE SKIP LOCKED` with
   stale claim recovery and bounded retries.

Everything shareable is shared (db pool, logger, metrics, connectors), while
per tenant state always routes through guild id parameters.

## Data flow for opportunities

```
source connector --httpJson--> NormalizedOpportunity[] --collector-->
  (dedup key, content fingerprint) --> opportunities (upsert, never fabricate)
                                        |
                                        v
                        changedIds (created + updated in this run)
                                        |
                                        v
          for each guild: matcher (tenant filters) --> delivery engine
                                        |
              unique (guild, opportunity, channel, kind) claim
                                        v
                       discord post  or  digest bucket
                                        |
                                        v
                      deadline scheduler materializes reminders
                      (offset minutes, IST aware presentation)
```

### Lifecycle

Listings get `open`, `closing_soon` (deadline near), `closed`, `removed` statuses.
A lifecycle sweep closes past deadlines and ages stale listings out of feeds.
Unknown facts stay `null` throughout; connectors never invent data.

### Dedup chain (no repetition)

1. `(source_id, external_id)` - exact source identity.
2. canonicalized URL key (host lowered, tracking params stripped, sorted query).
3. normalized title + organization key.
4. cross source likeness: same category + Jaccard(title tokens) >= 0.6 + same
   organization (or one unknown with overlapping URL host). Conservative on
   purpose: distinct opportunities with similar titles are never merged.
5. content fingerprint: meaningful fields only; announcement worthy changes get
   delivered once (keyed update), markdown-only changes never re-post.
6. `opportunity_deliveries` unique (guild, opportunity, channel, delivery kind)
   enforced in PostgreSQL; the claim is transactional (claim, send, adjust).

### Cadence

Per-source `interval_minutes` defaults to hourly (60 minutes); the parent
`sync_sources` job also runs hourly. A pass that finds nothing new posts
nothing (dedupe chain below). Each run records per source health (last run,
last success, streak of failures, errors) visible to admins and in the
integration API.

## Time zones

- All stored instants are UTC (`timestamptz` everywhere).
- Presentation uses the guild's IANA timezone; guilds with the default `UTC` label
  fall through to the deployment default (Asia/Kolkata) because "UTC" means
  "never configured".
- Digests dispatch when the local hour matches a guild's configured `digest_hours`
  (IST default window), computed by `src/jobs/digest-cal.ts`.

## Multi tenancy model

- Every tenant record carries `guild_id`. Tenant tables (guild_feature_settings,
  guild_channels, guild_preferences, guild_authorized_roles,
  opportunity_deliveries, deadline_notifications, audit_logs,
  infrastructure_hosts, infra_events) are protected with
  `FORCE ROW LEVEL SECURITY`.
- The policy uses the transaction local GUC `app.guild_id`:
  `guild_id = current_setting('app.guild_id') or app.guild_id = '__system__'`.
- TenantService opens `withTenant(guildId, ...)` transactions for all tenant
  reads/writes; system runs (collector, scheduler, maintenance jobs) use the
  connection default `__system__` scope with explicit guild filters in SQL.
- The pool never leaks context: `set_config(..., true)` is transaction scoped.

## Scheduler design

`scheduled_jobs` is the durable queue: `idempotency_key` (unique, null ok),
`status pending/running/done/failed`, `attempts`, `max_attempts`, `run_at`,
`last_error`, `correlation_id`. A single worker loop claims with
`FOR UPDATE SKIP LOCKED`, executes the handler map, and reschedules recurring
jobs by computing the next `run_at`. Stale running rows (crashed worker) are
recovered after a claim TTL. Retries back off exponentially up to max attempts.

## AI layer (optional, fail closed)

Groq provider is optional. Every AI call is budgeted (`AI_MONTHLY_REQUEST_BUDGET`)
and wrapped in `safeComplete` which returns null instead of throwing. Callers
render the base message without the summary when AI is unavailable. Untrusted
source text is passed through an `untrustedField()` wrapper and plain instruction
preamble to prevent prompt injection from reaching tool surfaces. CI diagnosis
excerpts are redacted before they leave the process.

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `/healthz` | public | liveness |
| `/readyz` | public | readiness (checks DB) |
| `/metrics` | gated | Prometheus exposition |
| `/api/admin/sources`, `/api/admin/jobs/failures` | bearer admin token | ops |
| `/api/integrations/health` | bearer integration token | single health report JSON |
| `/api/integrations/logs` | bearer integration token | structured failure feed |

## Key modules

| Path | Role |
| --- | --- |
| `src/database` | pool, drizzle client, migrations, RLS statements |
| `src/opportunities/connectors` | source fetchers (one file per source) |
| `src/opportunities/collectors/collector.ts` | sync orchestration, dedup, lifecycle |
| `src/opportunities/delivery` | delivery engine, deadline scheduler |
| `src/opportunities/matching` | tenant filters + ranking |
| `src/bot/*` | discord client, command modules, embeds, pagination |
| `src/jobs/*` | durable scheduler + handlers + digest calendar |
| `src/api/*` | express server, admin + integration routes |
| `src/core` | env, errors, logging, redaction, crypto, time, ids, http |
