# Orbit security

## Principles

1. Every tenant boundary is enforced in two places: PostgreSQL row level
   security (`FORCE RLS` + per transaction GUC) and the service layer
   (`TenantService` opens tenant scoped transactions). Neither alone is trusted.
2. Secrets are never stored in plaintext: GitHub App installation tokens are
   AES-256-GCM encrypted with `APP_ENCRYPTION_KEY` before landing in the DB.
3. All external input (source listings, workflow logs, webhook payloads) is
   untrusted and redacted before it is logged, summarized or sent onward.
4. Fail closed: with no signature, no secret or no credentials, the webhook
   and AI surfaces answer denials or degrade to no-op - they never "best effort"
   through.

## Secrets and where they live

| Secret | Where | Notes |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | env only | never logged (pino redaction + redact.ts patterns) |
| `GITHUB_WEBHOOK_SECRET` | env only | HMAC sha256 verification of webhook bodies |
| `GITHUB_APP_PRIVATE_KEY` | env or PEM file path | converts to short lived installation tokens |
| `APP_ENCRYPTION_KEY` | env only | 32 bytes base64; encrypts installation tokens at rest |
| `ADMIN_API_TOKEN` / `INTEGRATION_API_TOKEN` | env only | bearer tokens for admin and integration APIs |

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
  `__system__` sentinel: system runs (collector, scheduler, webhook pipeline)
  are cross tenant by definition and always filter by guild in SQL.
- Production role must be `NOSUPERUSER` (superusers bypass RLS). The compose
  file's `orbit` role is created by the `postgres` image init scripts as a plain
  login role.
- Verified by integration tests: guild A cannot read guild B rows and cross
  tenant inserts are rejected through the with-check clause.

## GitHub webhook verification

- Raw body required (express raw body parser on that route only).
- `X-Hub-Signature-256` (`sha256=<64 hex>`), constant-time comparison, strict
  format check; missing secret config = reject (`fail closed`).
- Body size capped at 10 MB (GitHub rarely exceeds 25 MB; we cut at 10).
- Replay/dedupe by `X-GitHub-Delivery` id stored in `github_webhook_deliveries`;
  duplicates short circuit before fan-out.
- Webhook handlers respond 202 fast and process asynchronously to stay within
  GitHub's 10 second timeout budget.

## Redaction

`redactString`/`redactDeep` cover tokens (GitHub PAT forms, discord base64
tokens, JWTs, AWS keys, groq keys, bearer/basic headers), `password/token/key
value` assignments and credentials in URLs. Sensitive keys anywhere in a
structure are redacted. Applied to: structured logs, workflow log excerpts,
error payloads, AI prompt contents and diagnostics.

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
publicly (see `docs/deployment.md` nginx snippet).

## What is NOT in scope

- Hardened multi process scaling (single node deployment supported; horizontal
  scale requires moving to the documented Postgres advisory lock leader model).
- Discord HTTP webhook interaction mode (gateway interactions only).
- Full WAF/DDoS posture of the public endpoint (reverse proxy responsibility).
