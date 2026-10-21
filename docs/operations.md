# Orbit operations runbook

One document, three phases: prepare the machine, fill credentials, operate
day to day. Complementary reads: `docs/scheduling.md` (scheduler internals
and job health), `docs/architecture.md` (data flow and RLS design),
`docs/security.md` (threat model), `docs/sources.md` (connectors) and
`docs/integrations.md` (call this instance from your own projects).

## 1. Staging now, production later

The current deployment is **staging**: tunnel name `orbit-staging`, hostname
`orbit-staging.webuildnow.in`. Everything in this guide assumes that
hostname. When you promote to production later, create a second tunnel
(`orbit`) with hostname `orbit.webuildnow.in`, point a new `.env` at it, and
only URLs and tokens change; no code path differs between the two.

## 2. Architecture in one paragraph

The `app` container runs migrations (including tenant row level security)
and then boots the Discord gateway, the durable Postgres scheduler and the
HTTP API (health, metrics, admin and integration APIs) in one process. The
`postgres:16` container is created with a dedicated NOSUPERUSER application
role by an init script; the app never connects as a superuser. The optional
`tunnel` container runs `cloudflared`, so the app gets a public HTTPS URL
with zero inbound ports opened on the host.

## 3. Prerequisites and machine preparation (Ubuntu 22.04 or 24.04)

- At least 1 vCPU and 1 GB RAM (2 GB recommended once you attach many
  guilds). Docker Engine 24+ with the compose plugin, installed as follows.
- A domain added to Cloudflare (free plan works).
- A Discord account (to create the bot application).

Install Docker:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git cron
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Add your user to the docker group or run compose with sudo. Enable security
updates: `sudo dpkg-reconfigure -plow unattended-upgrades`.

Close all inbound traffic; the tunnel (section 4) or a reverse proxy
(section 5) carries public traffic:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw enable
```

The compose file binds postgres to `127.0.0.1:5432` and the app to
`127.0.0.1:3000` on the host.

## 4. Cloudflare tunnel (the public URL)

The recommended setup has no open ports: the host firewall closes 3000 and
5432 to the public, and the tunnel profile publishes the app.

1. Cloudflare dashboard > Zero Trust > Networks > Tunnels > Create a tunnel >
   choose cloudflared > name it (e.g. `orbit`) > save. Copy the tunnel token.
2. On the tunnel page open Public Hostname > add:
   - Subdomain: `orbit` (any), Domain: your domain
   - Service Type: `HTTP`, URL: `app:3000`
   - Save. DNS record is created automatically.
3. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN=...` and enable it:
   `docker compose --profile tunnel up -d`.
4. Verify: `curl -s https://<your-hostname>/healthz` returns ok.

Note for this Cloudflare zone: Bot Fight Mode challenges scripted clients
and would 403 every ingest call to the public URL; keep it off for the
hostname the push API serves.

## 5. Alternative ingress (if not using the tunnel)

Standard nginx + certbot is fine because Orbit terminates HTTP internally:

```
server {
  server_name orbit.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    # admin API uploads: larger than json defaults
    client_max_body_size 10m;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Host $host;
  }
}
```

With certbot: `sudo certbot --nginx -d orbit.example.com`.

## 6. Credentials: fill `.env` once

```bash
cp .env.example .env
```

| Variable | Where it comes from | Notes |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal > your application > Bot > Reset Token | keep private; rotate if ever leaked |
| `DISCORD_APPLICATION_ID` | same page > General Information > Application ID | used for command registration and the invite link |
| `DISCORD_PUBLIC_KEY` | same page > General Information | only used by the unused HTTP webhook interaction mode |
| `POSTGRES_DB` | you | keep `orbit` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` | postgres superuser (host admin + backups only) |
| `POSTGRES_APP_PASSWORD` | `openssl rand -hex 16` | the orbit application role the app logs in as |
| `DATABASE_URL` | compose builds it | edit only for bare metal; format `postgresql://orbit:<POSTGRES_APP_PASSWORD>@<host>:5432/orbit` |
| `CLOUDFLARE_TUNNEL_TOKEN` | section 4 | empty disables the tunnel profile |
| `ADMIN_API_TOKEN` | `openssl rand -hex 32` | `/api/admin/*` bearer token |
| `INTEGRATION_API_TOKEN` | `openssl rand -hex 32` | `/api/integrations/*` bearer token for your own apps |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` | optional; reserved for future credential at rest |
| `GROQ_API_KEY` | optional, console.groq.com | without it everything still works, minus AI summaries |
| `AI_MONTHLY_REQUEST_BUDGET` | you | hard monthly cap on AI calls |
| `DEFAULT_TIMEZONE` | you | `Asia/Kolkata` (IST first) unless a guild overrides it |
| `DISCORD_REGISTER_COMMANDS` | `1` on first install | registers slash commands at boot |
| `RETENTION_DAYS` | you | cleanup window for event logs |
| `PGADMIN_EMAIL` | `you@yourdomain.dev` | login for pgAdmin at `http://127.0.0.1:5050`; reserved names like `*.local` fail its boot validation |
| `PGADMIN_PASSWORD` | `openssl rand -hex 18` | pgAdmin browser password; never reuse a real secret here |

Database roles: nothing manual is needed on an empty data volume. First boot
runs `docker/postgres-init/01-orbit-app-role.sh`, which creates the `orbit`
role (NOSUPERUSER, owns the database, gets `POSTGRES_APP_PASSWORD`) and pins
`app.guild_id = '__system__'` as a role-level default, so a direct
connection as `orbit` boots into the same system scope the app pool opens
with. The app container then applies migrations (`drizzle/*.sql`) and
installs FORCE row level security on all tenant tables before the bot
starts. Never point `DATABASE_URL` at the postgres superuser: superusers
bypass RLS no matter what policies say, and the whole tenant isolation
story only holds through a plain role.

## 7. Discord application and URLs

1. https://discord.com/developers/applications > New Application > name it
   Orbit.
2. General Information: note Application ID (`DISCORD_APPLICATION_ID`) and
   Public Key (`DISCORD_PUBLIC_KEY`).
3. Bot: Reset Token > copy into `DISCORD_BOT_TOKEN`.
4. Bot: enable no privileged intents (Orbit uses none; interaction payloads
   already carry member roles and permission bits).
5. Bot invite URL (paste your Application Id):

   ```
   https://discord.com/oauth2/authorize?client_id=<your application id>&scope=bot+applications.commands&permissions=52224
   ```

   Permissions code 52224 = View Channels + Send Messages + Embed Links +
   Attach Files. Do not grant Administrator. Include the
   `applications.commands` scope or slash commands never appear.
6. Interactions endpoint URL: leave empty. Orbit listens over the gateway;
   the HTTP interaction mode is not part of this deployment.
7. After first boot keep `DISCORD_REGISTER_COMMANDS=1` once; commands
   appear globally (may take a few minutes on Discord's side).

## 8. Install, first boot, verification

```bash
git clone <repo> /opt/orbit && cd /opt/orbit
cp .env.example .env     # then section 6
docker compose --profile tunnel up -d --build
docker compose logs -f app
```

Success looks like, in order:

1. `tenant RLS policies ensured` (migrations + row level security)
2. `{"applied":[N],"already":X}` or `{"applied":[],"already":N}`
3. `discord login` success (or retry logs if the token is bad)
4. `http surface listening`

Key checks:

```bash
# host only (ports are localhost bound)
curl -s http://127.0.0.1:3000/healthz
curl -s http://127.0.0.1:3000/readyz

# through the tunnel, with your integration token
curl -s -H "Authorization: Bearer $INTEGRATION_API_TOKEN" \
  https://.<your-hostname>/api/integrations/health
```

Expect `"status":"healthy"` once the app, DB, scheduler and sources have
settled. Guild setup inside Discord: run `/setup` in your server, then
`/features`, `/channels`, `/preferences`.

Verification checklist:

- [ ] `docker compose ps` shows app, postgres healthy (tunnel too if enabled)
- [ ] `/healthz` and `/readyz` return 200
- [ ] `/api/integrations/health` returns `status: healthy` with a DB latency
- [ ] `opportunity_sources` rows show recent `last_run_at`
- [ ] Backups cron is installed (`scripts/backup.sh`, section 10)

## 9. Compose lifecycle and upgrades

| Task | Command |
| --- | --- |
| status | `docker compose ps` |
| logs | `docker compose logs -f app` (add `tunnel`, `postgres`) |
| stop | `docker compose down` |
| start (no rebuild) | `docker compose --profile tunnel up -d` |
| rebuild after code change | `docker compose build app && docker compose --profile tunnel up -d` |

Upgrade:

```bash
git pull
docker compose build app
docker compose --profile tunnel up -d
```

Migrations apply at boot, in order, each in its own transaction, then tenant
RLS is re-installed idempotently. Rotating secrets: edit `.env`, then
`docker compose up -d` (recreate); tokens rotate via the same env vars.
Rolling back a schema change is not supported: restore a backup instead.

## 10. Backups and restore

Logical dumps via `pg_dump -Fc`, rotated by count (`ORBIT_BACKUP_KEEP`,
default 14). Cron example (2:30 AM IST daily):

```
30 2 * * * /opt/orbit/scripts/backup.sh /opt/orbit/backups >> /var/log/orbit-backup.log 2>&1
```

Restore (app stopped):

```bash
docker compose stop app
scripts/restore.sh backups/orbit_backup_YYYYMMDD_HHMMSS.dump
docker compose start app
```

## 11. Health surfaces

| Surface | Auth | Use |
| --- | --- | --- |
| `/healthz` | public | process liveness (compose healthcheck) |
| `/readyz` | public | readiness incl. database ping |
| `/metrics` | admin bearer (or local) | Prometheus text exposition |
| `/api/admin/sources` | admin bearer | source registry state |
| `/api/admin/jobs/failures` | admin bearer | recent scheduler failures |
| `/api/integrations/health` | integration bearer | full machine readable report |
| `/api/integrations/logs` | integration bearer | structured event feed |

Both bearer tokens come from `ADMIN_API_TOKEN` and `INTEGRATION_API_TOKEN`;
a missing integration token disables those routes (503) rather than opening
them.

## 12. The integration report

`GET /api/integrations/health` returns one JSON object your own tooling can
poll:

```bash
curl -s -H "Authorization: Bearer $ORBIT_TOKEN" \
  https://orbit.example.com/api/integrations/health | jq .
```

Interpreting the fields:

- `status`: `healthy` / `degraded` / `unhealthy`
- `checks.database`: reachable flag and last ping latency in ms
- `checks.scheduler.counts`: live queue histogram; `stuckPending` should
  stay near 0 (stale running rows recover automatically)
- `checks.sources[]`: per source `lastRunAt`, `lastSuccessAt`, `lastError`,
  `consecutiveFailures`; a growing failure streak means the upstream API is
  degraded or egress is blocked
- `checks.deliveries.last24h`: delivered vs failed message outcomes
- `checks.catalog`: opportunity totals (open, closingSoon, withDeadline)
- `warnings[]`: non fatal observations (e.g. a source with a failure streak)

`GET /api/integrations/logs?since_minutes=&level=&limit=` (limit capped at
300) returns timestamped events from jobs, sources and deliveries; it reads
persisted state, never raw stdout, so it survives log rotation.

## 13. Scheduler

Jobs live in `scheduled_jobs`. Normal cadence:

| Job | Interval | Does |
| --- | --- | --- |
| `sync_sources` | hourly (per source `interval_minutes` also applies, hourly by default) | collects due sources, dedupes, fans out fresh listings |
| `lifecycle_sweep` | hourly | closes past deadlines, ages listings |
| `deadline_sweep` | 15 min | sends due deadline reminder rows |
| `digest_dispatch` | hourly | dispatches digests when a guild's local hour matches `digest_hours` (IST default window) |
| `infra_sweep` | 15 min | project watchdog: flags silent pushes, announces recovery |
| `retention_cleanup` | daily | prunes old event and job rows (`RETENTION_DAYS`) |

Inspect the queue (host side):

```bash
docker compose exec postgres psql -U postgres -d orbit -c \
  "select job_type, status, attempts, run_at, last_error from scheduled_jobs order by run_at limit 20;"
```

A recurring row that ends `done` and never goes `pending` again is a dead
chain (fixed in current code by a claim-mapping regression test); the
integration suite covers it (`scheduler-rearm.test.ts`).

## 14. Logs

Structured JSON on stdout only (`docker compose logs app`). Pino redaction
scrubs credential shaped strings. Levels by env: `LOG_LEVEL=debug` for
verbose, `info` normal, `warn` on recoverables (e.g. Discord login retry is
warn on purpose: the HTTP plane stays up while the gateway reconnects).

## 15. Incidents and troubleshooting

| Situation | Runbook |
| --- | --- |
| integrations report `unhealthy` (db unreachable) | `docker compose ps` postgres; restart; check disk full |
| `degraded` with source failure streaks | read `lastError`; if upstream API died, mark the source disabled in `opportunity_sources` and investigate; Orbit keeps running with the remaining sources |
| digest never fires | guild timezone set to UTC means "not configured" (falls back to deploy default); check `digest_hours` and the digest channel binding |
| too many posts per channel | lower quota via guild preferences; deliveries are quota capped daily and deduplicated per (channel, kind) |
| AI suddenly absent | quota exhausted or provider down by design; product degrades without error spam |
| `discord login failed; retrying` in logs | wrong/expired `DISCORD_BOT_TOKEN`; HTTP stays on, gateway retries |
| `command registration failed` | token/app id mismatch, or `applications.commands` not registered for this app |
| DB error 42501 (row level security) | app is connecting as superuser; use the orbit role (section 6) |
| tunnel offline | token expired or revoked; `docker compose logs tunnel` |
| public URL 403 "Just a moment" | Cloudflare Bot Fight Mode or a challenge custom rule; exempt or disable for the API hostname |
| sources stale in integrations report | upstream API failing or egress blocked; per source `lastError` in the report |

## 16. Database hygiene, capacity and sizing

- `VACUUM (ANALYZE)` nightly is handled by autovacuum defaults; no cron.
- Restore drill: practice the restore path in staging quarterly.
- Rotating `APP_ENCRYPTION_KEY` requires re-encrypting stored secrets;
  treat it like a break-glass action.
- Single node by design; the scheduler uses `FOR UPDATE SKIP LOCKED` claims
  so a second app pod would be safe to add, but MongoDB-style multi host is
  not targeted yet.
- Pool is fixed at 10 connections; if you see connection exhaustion, check
  for long transactions (delivery claims hold a transaction across the
  Discord send by design).
- 1 vCPU, 1 GB RAM runs a few dozen guilds comfortably; the Postgres pool
  caps at 10 connections and the scheduler at 4 concurrent jobs.
- Disk growth comes from events and deliveries; `RETENTION_DAYS` cleanup
  runs nightly (`retention_cleanup`).

Data lives in the named volume `pgdata`. The `backups/` folder on the host
is mounted into the postgres container for convenient snapshot writes.
Useful host-side commands:

```bash
docker compose exec postgres psql -U postgres -d orbit       # admin shell
docker exec -i "$(docker compose ps -q postgres)" psql -U postgres -d orbit < dump.sql
```

Database visualization: pgAdmin ships in compose and listens on
`http://127.0.0.1:5050` only. Log in with `PGADMIN_EMAIL` / `PGADMIN_PASSWORD`;
the database is pre-registered as "Orbit (staging)" connecting as the `orbit`
role. Scale the service down (`docker compose stop pgadmin`) when you do not
need it, and never route it through the public tunnel. Ready-made monitoring
queries live in `docker/pgadmin/monitoring.sql`: open them via Query Tool >
Open File; the first block is a one-glance health verdict.
