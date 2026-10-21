# Orbit production guide

This is the end to end setup: one Ubuntu host, one PostgreSQL, one public
HTTPS URL through a Cloudflare tunnel, and every credential Orbit needs.
Follow it top to bottom and you end up with a running deployment verified by
the checklist in section 10.

See also: `docs/deployment.md` (machine prep, upgrades, backups), `docs/operations.md`
(runbook), `docs/security.md` (threat model) and `docs/integrations.md` (call
this instance from your own projects).

## 0. Staging now, production later

The current deployment is **staging**: tunnel name `orbit-staging`, hostname
`orbit-staging.webuildnow.in`. Everything in this guide assumes that hostname.
When you promote to production later, create a second tunnel
(`orbit`) with hostname `orbit.webuildnow.in`, point a new `.env` at it, and
only URLs and tokens change; no code path differs between the two.

## 1. Architecture in one paragraph

The `app` container runs migrations (including tenant row level security) and
then boots the Discord gateway, the durable Postgres scheduler and the HTTP
API (health, metrics, admin and integration APIs) in one
process. The `postgres:16` container is created with a dedicated
NOSUPERUSER application role by an init script; the app never connects as a
superuser. The optional `tunnel` container runs `cloudflared`, so the app
gets a public HTTPS URL with zero inbound ports
opened on the host.

## 2. Prerequisites

- An Ubuntu 22.04 (or 24.04) host or VPS with at least 1 vCPU and 1 GB RAM
  (2 GB recommended once you attach many guilds).
- A domain you have added to Cloudflare (free plan works).
- Docker Engine 24+ with the compose plugin: see `docs/deployment.md`
  section 1 for exact commands.
- Discord account (to create the bot application).

## 3. Cloudflare tunnel (the public URL)

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
4. Verify: `curl -s https://orbit-staging.webuildnow.in/healthz` returns ok.

Alternative: run your own nginx + TLS (nothing in Orbit needs a reverse
proxy except public reachability), or use cloudflared's local config file
mount if you prefer file based ingress over dashboard managed rules.

## 4. Credential walkthrough (fill `.env` once)

Copy the template and fill every value from the table:

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
| `CLOUDFLARE_TUNNEL_TOKEN` | section 3 | empty disables the tunnel profile |
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

## 5. Database setup (automatic)

Nothing manual is needed: on first boot of an empty data volume, compose runs
`docker/postgres-init/01-orbit-app-role.sh`, which creates the `orbit` role
(NOSUPERUSER, owns the database) and passes it the `POSTGRES_APP_PASSWORD`.
The app container then runs migrations (`drizzle/*.sql`) and installs FORCE
row level security policies on all tenant tables before the bot starts.

Why this matters: PostgreSQL superusers bypass RLS no matter what policies
say. The whole tenant isolation story (guild A can never read or write guild
B) only holds when the application role is a plain role. Never point
`DATABASE_URL` at the postgres superuser.

The same init script pins `app.guild_id = '__system__'` as a role-level
default, so a direct connection as `orbit` boots into the same system scope
the app pool opens with (row counts in pgAdmin match the running app; tenant
scoping still comes exclusively from `TenantService` at runtime).

Database visualization: pgAdmin ships in compose and listens on
`http://127.0.0.1:5050` only. Log in with `PGADMIN_EMAIL` / `PGADMIN_PASSWORD`;
the database is pre-registered as "Orbit (staging)" connecting as the `orbit`
role. Scale the service down (`docker compose stop pgadmin`) when you do not
need it, and never route it through the public tunnel. Ready-made monitoring
queries live in `docker/pgadmin/monitoring.sql`: open them via Query Tool >
Open File; the first block is a one-glance health verdict.

Useful host-side commands:

```bash
docker compose exec postgres psql -U postgres -d orbit       # admin shell
docker exec -i "$(docker compose ps -q postgres)" psql -U postgres -d orbit < dump.sql
```

Backups and restore are covered in `docs/deployment.md`; cron them.

## 6. Discord application and URLs

1. https://discord.com/developers/applications > New Application > name it
   Orbit.
2. General Information: note Application ID (`DISCORD_APPLICATION_ID`) and
   Public Key (`DISCORD_PUBLIC_KEY`).
3. Bot: Reset Token > copy into `DISCORD_BOT_TOKEN`.
4. Bot: enable no privileged intents (Orbit uses none; interaction payloads
   already carry member roles and permission bits).
5. Bot invite URL (paste your Application Id):

   ```
   https://discord.com/oauth2/authorize?client_id=1562027185139879969&scope=bot+applications.commands&permissions=52224
   ```

   Permissions code 52224 = View Channels + Send Messages + Embed Links +
   Attach Files. Do not grant Administrator.
6. Interactions endpoint URL: leave empty. Orbit listens over the gateway;
   the HTTP interaction mode is not part of this deployment.
7. After first boot keep `DISCORD_REGISTER_COMMANDS=1` once; commands
   appear globally (may take a few minutes on Discord's side).

## 7. First boot

```bash
docker compose --profile tunnel up -d --build
docker compose logs -f app
```

Success looks like, in order:

1. `tenant RLS policies ensured` (migrations + row level security)
2. `{"applied":[N],"already":X}` or `{"applied":[],"already":N}`
3. `discord login` success (or retry logs if the token is bad)
4. `http surface listening`

## 8. Run key checks

```bash
# host only (ports are localhost bound)
curl -s http://127.0.0.1:3000/healthz
curl -s http://127.0.0.1:3000/readyz

# through the tunnel, with your integration token
curl -s -H "Authorization: Bearer $INTEGRATION_API_TOKEN" \
  https://orbit.<your-domain>/api/integrations/health
```

Expect `"status":"healthy"` once the app, DB, scheduler and sources have
settled. Guild setup inside Discord: run `/setup` in your server, then
`/features`, `/channels`, `/preferences`.

## 9. Verification checklist

- [ ] `docker compose ps` shows app, postgres healthy (tunnel too if enabled)
- [ ] `/healthz` and `/readyz` return 200
- [ ] `/api/integrations/health` returns `status: healthy` with a DB latency
- [ ] `opportunity_sources` rows show recent `last_run_at`
- [ ] Backups cron is installed (`scripts/backup.sh`, see deployment doc)

## 10. Upgrade and rotate

```bash
git pull
docker compose build app
docker compose --profile tunnel up -d
```

Migrations run automatically at boot and are idempotent. Rotating secrets:
edit `.env`, then `docker compose up -d` (recreate); tokens rotate via the same env vars.

## 11. Troubleshooting

| Symptom | First checks |
| --- | --- |
| `discord login failed; retrying` in logs | wrong/expired `DISCORD_BOT_TOKEN`; HTTP on, gateway retries |
| `command registration failed` | token/app id mismatch, or `applications.commands` not registered for this app |
| DB error 42501 (row level security) | app is connecting as superuser; use the orbit role (section 5) |
| tunnel offline | token expired or revoked; `docker compose logs tunnel` |
| sources stale in integrations report | upstream API failing or egress blocked; per source `lastError` in the report |
| job dead chain (long ago versions) | fixed by the re-arm regression; update to current code |
