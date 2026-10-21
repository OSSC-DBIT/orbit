# Orbit

Orbit is a production oriented, multi tenant Discord bot and platform that discovers,
normalizes, deduplicates and delivers developer opportunities (hackathons, internships,
jobs, innovation challenges).

One bot instance serves many Discord guilds (tenants). Every record and every config
meets a guild id. Admins of one guild can never see or change another guild's data,
enforced both by row level security in PostgreSQL and by service layer checks.

- Stack: Node.js 22 LTS, TypeScript (strict), discord.js 14, Express 5, PostgreSQL 16, Drizzle ORM
- AI: optional Groq summaries; the app is fully functional without AI and never fails because of it
- Deployment: Docker Compose (app + postgres), self hosted on a single Ubuntu box
- Timezones: IST first (Asia/Kolkata default) with per guild overrides

## Feature map

| Area | What you get |
| --- | --- |
| Opportunities | Slash commands, paginated browsing, search, category feeds, deadlines in tenant timezone |
| Delivery | Instant posts, digests (tenant local hours), volume capped with daily quota |
| No repetition | Content fingerprinting + unique (guild, opportunity, channel, kind) deliveries |
| Sources | 6 connectors with health tracking (see `docs/sources.md`) |
| Ops | `/api/integrations/health` report, `/api/integrations/logs` failure feed, Prometheus metrics |
| Trust | Audit log, admin gating, log redaction, backup scripts |

## Quick start (Docker Compose)

```bash
git clone <repo> /opt/orbit && cd /opt/orbit
cp .env.example .env      # fill in real values (see docs/production-guide.md)
docker compose --profile tunnel up -d --build
docker compose logs -f app
```

Current staging instance: https://orbit-staging.webuildnow.in via Cloudflare
tunnel. Legal pages are served at `/privacy` and `/terms`.

The app container runs idempotent migrations (including tenant RLS) then boots:
gateway, command registration, scheduler and API in one process.

## Slash commands

Core: `/help` `/setup` `/status` `/timezone` `/authorized-roles` `/audit-log`

Config: `/features` `/channels` `/preferences` `/digest` `/sources`

Opportunities: `/opportunities` (`browse`, `detail`, `search`, `deadline`, `subscribe`, `unsubscribe`, category variants)

All config mutations are admin gated (`Administrator`, `Manage Server`,
or a principal listed via `/authorized-roles`). Authorization is strictly per guild;
everyone can browse opportunities without any role.

## Hourly sync, no repetition

Sources are collected on a durable Postgres backed scheduler (no Redis). The
parent pass runs every hour and per-source `interval_minutes` is hourly by
default, so new hackathons/jobs/internships surface within roughly an hour of
publication. If a pass finds nothing new it posts nothing. Repetition is
blocked by a chain:

1. content fingerprint per listing (meaningful fields; presentation changes ignored)
2. unique `opportunity_deliveries` rows per (guild, opportunity, channel, delivery kind)
3. per tenant daily delivery quota with volume capping

Digests and deadline reminders fire in each guild's own timezone; the deployment
default is Asia/Kolkata.

## Integration API (for your own apps)

Culture bearer token auth (`INTEGRATION_API_TOKEN`):

Get a full health report:

```bash
curl -H "Authorization: Bearer $ORBIT_TOKEN" https://orbit.example.com/api/integrations/health
```

Returns app, version, generatedAt, status (healthy / degraded / unhealthy),
checks (database latency, scheduler counts, failures, per source health, delivery
pulse, catalog stats, tenant count) and warnings.

Pull recent structured failures and log events:

```bash
curl -H "Authorization: Bearer $ORBIT_TOKEN" \
  "https://orbit.example.com/api/integrations/logs?level=error&since_minutes=1440&limit=100"
```

Events are assembled from persisted state (scheduler failures, source errors,
delivery failures), never from raw stdout.

## Sources

Detailed per source documentation (endpoints, fields, licensing, limits) lives in
`docs/sources.md`. Supported: JobSpy (Indeed+Naukri pilot), Devpost, Remotive, Hacker News Algolia,
hackathon api (0xarchit/hackathon-api, MIT) and HackCulture. MLH and Devfolio are
not integrated because their public endpoints are dead.

## Documentation

- `docs/production-guide.md` - the full setup: Cloudflare tunnel, Discord
  URLs, every credential
- `docs/architecture.md` - data flow, RLS design, scheduler, dedup chain
- `docs/security.md` - threat model, secrets, redaction
- `docs/deployment.md` - machine prep, compose lifecycle, backups, upgrades
- `docs/operations.md` - runbook: health, jobs, incidents, capacity
- `docs/sources.md` - source connectors in detail
- `docs/cadence.md` - automatic delivery cadence and how no repetition is guaranteed
- `docs/integrations.md` - the integration API: health report, failure feed,
  metrics, examples in curl/Node/Python/Prometheus for your own projects

## Development

```bash
npm install
npm run test:unit                   # offline unit tests
npm run typecheck
npm run lint

# optional: full suite against a throwaway postgres
docker run --rm -d --name orbit-test-pg -p 54329:5432 \
  -e POSTGRES_PASSWORD=test postgres:16-alpine
ORBIT_TEST_DATABASE_URL=postgresql://postgres:test@localhost:54329/postgres npm test
```

## Maintained by

Orbit is maintained by **OSSC DBIT, Bangalore** (Open Source Software Club,
Don Bosco Institute of Technology, Bengaluru) together with its contributors.

## Community

- [Code of conduct](CODE_OF_CONDUCT.md) - the Contributor Covenant applies
  to all community spaces
- [Contributing guide](CONTRIBUTING.md) - dev setup, scripts, PR checklist
- [Security policy](SECURITY.md) - private vulnerability reporting
- [AGENTS.md](AGENTS.md) - invariants for AI coding agents working on this repo
- Privacy policy and terms of service ship with every instance, served at
  `/privacy` and `/terms` (`docs/privacy.md`, `docs/terms.md`)

## License

Repository code is released under the MIT license (see [`LICENSE`](LICENSE)).
The `hackathon api` source connects to the MIT licensed community aggregator
[0xarchit/hackathon-api](https://github.com/0xarchit/hackathon-api); its license
terms apply to that service and Orbit records attribution on every record and
embed from it.
