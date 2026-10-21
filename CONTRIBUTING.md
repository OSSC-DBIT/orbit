# Contributing to Orbit

Thanks for taking the time to contribute. This document explains how to set up
a development environment and the standards this repository holds.

## Code of conduct

By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). Report violations through GitHub
(private mention of the maintainers) as described there.

## Development environment

Requirements:

- Node.js 22 or newer (`node -v`)
- Docker (optional but recommended for the integration test database)
- PostgreSQL 16 (via Docker is easiest)

```bash
npm install
cp .env.example .env    # development values; the bot needs a real token to boot
```

Environment validation runs at boot and in scripts; it is skipped inside
Vitest (`ORBIT_SKIP_ENV_VALIDATION=1` is preset by `vitest.config.ts`).

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | run the app with hot reload (tsx watch) |
| `npm run typecheck` | strict type check of src and tests |
| `npm run lint` | eslint over src and test |
| `npm run format` | prettier write over src and test |
| `npm test` | full suite (unit + integration when a DB is configured) |
| `npm run test:unit` | offline unit tests only |
| `npm run test:integration` | integration tests only (self skip without a DB) |
| `npm run build` | compile to `dist/` (pins `rootDir: src`) |
| `npm run db:generate` | generate a drizzle migration from schema changes |
| `npm run db:migrate` | apply migrations and install tenant RLS |
| `npm run bot:register-commands` | register slash commands with Discord |

## Running the integration suite

Integration tests validate migrations, row level security and cross tenant
denials against a real Postgres. They skip automatically when
`ORBIT_TEST_DATABASE_URL` is unset:

```bash
docker run --rm -d --name orbit-test-pg -p 54329:5432 \
  -e POSTGRES_PASSWORD=test postgres:16-alpine
ORBIT_TEST_DATABASE_URL=postgresql://postgres:test@localhost:54329/postgres npm test
```

The harness migrates as the admin role, then creates a dedicated NON
superuser `orbit_app` role and asserts isolation as that role.

## Pull requests

1. Fork or branch from `main`. Keep branches one concern per PR.
2. Make the change with tests. Bug fixes should include a regression test.
3. Run `npm run lint`, `npm run typecheck` and `npm test` before opening the
   PR. If there is no local Postgres, at minimum run `npm run test:unit`; CI
   runs the full suite.
4. Fill the PR template and check every item.

Commit style: short imperative subject line, e.g. `fix: re-arm recurring
jobs after completion`. Reference issues in the body (`closes #123`).

## Code standards

- TypeScript strict, ESM, NodeNext: use explicit `.js` suffixes on relative
  imports.
- Tenant safety first: new tenant table access goes through `TenantService`
  (or an explicit `withTenant` transaction). Never bypass row level security
  assumptions.
- Data honesty: preserve unknown fields as `null`; never invent deadlines,
  locations or compensation for sourced listings.
- Redaction: anything derived from untrusted source text or credentials gets
  redacted before it touches logs, AI prompts, or outbound messages.
- Time zones: store instants in UTC; present them in the guild timezone with
  the deployment default Asia/Kolkata.
- Docs: no em dashes or en dashes in `.md` files; keep embed copy plain ASCII.
- `.env.example` must contain placeholders only, never real tokens.

## Database migrations

Schema changes: edit `src/database/schema/index.ts`, run
`npm run db:generate`, review the generated `drizzle/NNNN_*.sql`, then verify
`npm run db:migrate` applies it on an empty database. The migrate runner also
(install idempotently) FORCE row level security policies on all tenant tables,
so new tenant tables must be added to `tenantTables` in the schema index.

## Releases

Releases are date based, not semver:

1. Append a section dated DD.MM.YYYY to `CHANGELOG.md`, written from the
   deployer's point of view (what changed and what to watch out for).
2. Set `package.json` `version` and the `Version:` stamp in `AGENTS.md` to
   the same date.
3. Tag with the date itself and publish a GitHub release:

   ```bash
   git tag -a 21.10.2026 -m "Orbit 21.10.2026 (stable)"
   git push origin 21.10.2026
   gh release create 21.10.2026 --title "Orbit 21.10.2026 (stable)" \
     --notes-file release-notes.md --latest
   ```

   Detailed notes derive from that `CHANGELOG.md` section plus the staging
   verification results.

## Security

See `SECURITY.md` for private vulnerability reporting. Please do not open
public issues for exploitable findings.

## License

Contributions are licensed under the repository's MIT license
(see `LICENSE`). The `hackathon api` source connector integrates with the MIT
licensed 0xarchit/hackathon-api service; its terms apply to that service.
