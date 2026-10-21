# Orbit security

## Principles

1. Every tenant boundary is enforced in two places: PostgreSQL row level
   security (`FORCE RLS` + per transaction GUC) and the service layer
   (`TenantService` opens tenant scoped transactions). Neither alone is trusted.
2. Secrets are never stored: Discord, pgAdmin and Groq credentials live only in
   the operator's `.env`; the database holds no credentials at all.
3. All external input (source listings, source payloads) is untrusted and
   redacted before it is logged, summarized or sent onward.
4. Fail closed: with no token or no credentials, the admin, integration and
   AI surfaces answer denials or degrade to no-op - they never "best effort"
   through.

## Secrets and where they live

| Secret | Where | Notes |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | env only | never logged (pino redaction + redact.ts patterns) |
| `APP_ENCRYPTION_KEY` | env only | optional; reserved for any future credential at rest |
| `ADMIN_API_TOKEN` / `INTEGRATION_API_TOKEN` | env only | bearer tokens for admin and integration APIs |
| Project enrol token | Discord `/project add` / `/project token`, shown once | bearer for the project ingest API; only the sha256 hash is stored (never the token) |

`.env` is git ignored and excluded from the Docker build context. The `.env.example`
template is committed with placeholders only. Rotate any value that ever entered
a log or a ticket.

## Discord interaction authN/authZ

- Interactions are authenticated by the gateway (signed payloads).
- Administrative commands run `evaluateAdminAuthorization` with facts extracted
  from the interaction: guild id, user id, member permission bits, member roles,
  and the guild's `guild_authorized_roles` rows.
- Reasons are explicit (`allowed-guild-admin`, `allowed-listed-principal`,
  `not-guild-admin`, ...). Authorization rows are per guild: a principal
  authorized in guild A is never valid for guild B (tested in
  `test/unit/authorization.test.ts`).
- All admin actions write to `audit_logs` (actor, action, target, correlation id).

## Row level security

- Tenant tables: `enable + FORCE row level security`, one policy per table:
  ```sql
  guild_id = coalesce(nullif(current_setting('app.guild_id', true), ''), '__no_tenant__')
  or current_setting('app.guild_id', true) = '__system__'
  ```
- TenantService sets the GUC inside `BEGIN ... COMMIT` via `set_config(..., true)`
  (transaction local). Pooled connections cannot leak a tenant context.
- The deployment connects through a pool whose session default is the
  `__system__` sentinel: system runs (collector, scheduler, maintenance jobs)
  are cross tenant by definition and always filter by guild in SQL.
- Production role must be `NOSUPERUSER` (superusers bypass RLS). The compose
  file's `orbit` role is created by the `postgres` image init scripts as a plain
  login role.
- Verified by integration tests: guild A cannot read guild B rows and cross
  tenant inserts are rejected through the with-check clause.

## Redaction

`redactString`/`redactDeep` cover tokens (GitHub PAT forms, discord base64
tokens, JWTs, AWS keys, groq keys, bearer/basic headers), `password/token/key
value` assignments and credentials in URLs. Sensitive keys anywhere in a
structure are redacted. Applied to: structured logs, error payloads, AI
prompt contents and diagnostics.

## AI layer

- Optional and fail closed: quotas and provider errors return null; callers
  degrade gracefully rather than fail.
- Budget constrained (`AI_MONTHLY_REQUEST_BUDGET`).
- Source-derived text is wrapped as untrusted data (`untrustedField`) with a
  prompt safety preamble; AI output is bounded (max tokens) and never rendered
  as markdown links from unverified URLs.

## Rate limiting and courtesy

Shared `httpFetch` gives per host client side rate limiting, bounded retries
with jitter, timeouts and a response size cap. Source limits are deliberately
conservative for undocumented endpoints. The admin API and integration API are
bearer gated; apply external rate limiting at the reverse proxy if exposed
publicly (see `docs/operations.md` nginx snippet).

## What is NOT in scope

- Hardened multi process scaling (single node deployment supported; horizontal
  scale requires moving to the documented Postgres advisory lock leader model).
- Discord HTTP webhook interaction mode (gateway interactions only).
- Full WAF/DDoS posture of the public endpoint (reverse proxy responsibility).
