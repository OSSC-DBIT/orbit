# AGENTS.md

Guide for AI coding agents (and newcomers) working in the Orbit repository.
Read this before editing anything. It encodes invariants that regression tests
and reviewers will hold you to.

Version: 21.10.2026. Releases are date based: the git tag and the release
name are the release date itself (for example `21.10.2026`), not semver.
On every release, bump this date, append the entry in `CHANGELOG.md` and
tag that date. Repo docs live in 8 files only, keep it that way when
touching docs.

## What Orbit is

A multi tenant Discord bot and platform that discovers, normalizes,
deduplicates and delivers developer opportunities (hackathons, internships,
jobs) and lets external projects push health and failure events into their
own Discord channels (project monitoring, bearer enrol tokens). Single
process: Discord gateway + Express API + Postgres backed scheduler. Self
hosted via Docker Compose on Ubuntu. IST (Asia/Kolkata) is the default
timezone everywhere.

## Non negotiable invariants

1. Multi tenancy: every tenant record carries `guild_id`. User triggered
   tenant-table reads and writes go through `TenantService`, which opens
   `withTenant(guildId, ...)` transactions. A guild A admin must never be able
   to affect guild B. Cross tenant denial is asserted in tests.
2. Never fabricate data: if a source does not provide a field (deadline,
   compensation, location), it stays `null`. TBA becomes null. Past or undated
   hackathons are dropped, not invented. HackCulture cards carry no deadline
   and must never gain one.
3. Unknown fields are preserved as `null` and logged at most; they are never
   filled with guesses.
4. AI is optional and fails closed: every AI call returns `null` on error or
   budget exhaustion. Callers must render a complete product without AI.
5. Source text is untrusted: redact before logging or sending onward, wrap in
   `untrustedField` for AI, and never render unverified URLs as markdown links.
6. Secrets never go into the database unencrypted (AES-256-GCM with
   `APP_ENCRYPTION_KEY`), never into logs (pino redaction + `redactString`),
   and never into `.env.example` (placeholders only).
7. Webhooks fail closed: missing or invalid `X-Hub-Signature-256` rejects.
8. Documentation and embed copy: no em dashes or en dashes anywhere in docs
   (`.md`); keep embed titles and footer text plain ASCII.

## Stack facts (do not drift)

- Node.js 22+ ESM, TypeScript strict, `"module": "NodeNext"`: relative imports
  must use explicit `.js` extensions even in `.ts` source.
- Database driver is `node-postgres` (`pg`). Code in 12 places expects the
  `{ rows }` result shape from `getDb()`. Do not reintroduce `postgres` (the
  postgres.js driver) and do not mix drivers.
- Drizzle ORM with `casing: "snake_case"` and drizzle-kit migrations in
  `drizzle/NNNN_*.sql`. `src/database/migrate.ts` applies each file in a
  transaction and then idempotently installs tenant RLS (`FORCE ROW LEVEL
  SECURITY` with the `__system__` sentinel policy). Its direct run check
  matches both `migrate.ts` and compiled `migrate.js`.
- The connection pool sets a session default of
  `app.guild_id = __system__` (system scope) and `withTenant` overrides it
  transaction locally with `set_config(..., true)`. Never set tenant context at
  session level; contexts must not leak across pooled connections.
- Scheduler claims are transactional (`FOR UPDATE SKIP LOCKED`). The
  `scheduled_jobs.idempotency_key` unique index is PARTIAL
  (`where idempotency_key is not null and status != 'cancelled'`): any raw
  `on conflict (idempotency_key)` clause must repeat the index predicate, or
  Postgres rejects the insert. Drizzle `onConflictDoNothing()` without an
  explicit target is safe for arbitrary conflicts.
- TypeScript builds via `tsconfig.build.json` which pins `rootDir: "src"`,
  producing `dist/index.js` and `dist/database/migrate.js` directly under
  `dist`. Do not compile `drizzle.config.ts` in the build or the output tree
  moves to `dist/src`.

## Commands

```bash
npm run typecheck     # tsc --noEmit (src + tests)
npm run lint          # eslint src + test
npm run test:unit     # offline unit tests only
npm test              # unit + integration (integration self-skips without a DB)
npm run build         # tsc -p tsconfig.build.json -> dist/
npm run db:generate   # drizzle-kit generate (schema -> drizzle/NNNN_*.sql)
npm run db:migrate    # run migrations + RLS install (tsx)
npm run bot:register-commands   # push slash commands to Discord
```

Integration tests need a real Postgres and are skipped (not failed) when
`ORBIT_TEST_DATABASE_URL` is unset:

```bash
docker run --rm -d --name orbit-test-pg -p 54329:5432 \
  -e POSTGRES_PASSWORD=test postgres:16-alpine
ORBIT_TEST_DATABASE_URL=postgresql://postgres:test@localhost:54329/postgres npm test
```

The harness runs migrations as the admin role, bootstraps a NON superuser
`orbit_app` role, and asserts RLS as that role (superusers bypass row level
security, so tenant isolation is only meaningfully testable through a plain
role).

## Test conventions

- Vitest. Unit tests must be fully offline: no real `fetch`, no DB, no Discord;
  stub with fixtures mirrored verbatim from real upstream payloads.
- Integration tests live in `test/integration/` and gate on
  `ORBIT_TEST_DATABASE_URL` via `describe.skip` when unset.
- When you add a source connector, mirror a real response fixture into
  `test/unit/connectors-offline.test.ts` for offline coverage.

## Where things live

| Path | Role |
| --- | --- |
| `src/core` | env config, errors, crypto, redaction, logging, time (IST helpers), http client |
| `src/database` | pool/client (`pg`), drizzle schema, migrations, RLS statements |
| `src/tenants` | authorized principals, `TenantService` (the only path to tenant tables) |
| `src/opportunities/connectors` | source fetchers, one file per source + registry |
| `src/opportunities/collectors` | sync orchestration, dedup chain, lifecycle sweep |
| `src/opportunities/normalization` | text, URL and date normalization |
| `src/opportunities/delivery` | delivery engine (transactional claims), deadline scheduler |
| `src/opportunities/matching` | tenant filters and ranking |
| `src/monitoring` | project status monitoring (push): ingest service, token hash, stale watchdog, announce fanout |
| `src/bot/*` | discord client (non fatal login retry), embeds, commands, pagination |
| `src/jobs/*` | durable scheduler, job handlers, digest calendar |
| `src/api/*` | express server: health, metrics, admin, integration and project ingest routes |
| `docs/*` | architecture, operations, scheduling, integrations, sources |

## Definition of done

Before you claim work is finished: `npm run typecheck` and `npm run lint` are
green and `npm run test:unit` (at minimum) passes. If a Postgres is available
run the full `npm test`. If you touched the schema, generate a migration and
make sure `npm run db:migrate` runs cleanly on an empty database. If you
changed docs make sure no em or en dashes crept in and that `.env.example`
still contains placeholders only (no real tokens, no real URLs with
credentials).
