# Orbit deployment

Machine level deployment runbook. Credential and URL setup lives in
`docs/production-guide.md`; day-2 operations in `docs/operations.md`.

## 1. Machine preparation (Ubuntu)

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

## 2. Firewall

Close everything; Cloudflare tunnel (or your own proxy) carries public
traffic:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw enable
```

The compose file binds postgres to `127.0.0.1:5432` and the app to
`127.0.0.1:3000` on the host.

## 3. Install

```bash
git clone <repo> /opt/orbit && cd /opt/orbit
cp .env.example .env     # then follow docs/production-guide.md
docker compose --profile tunnel up -d --build   # tunnel profile when used
```

## 4. Compose lifecycle

| Task | Command |
| --- | --- |
| status | `docker compose ps` |
| logs | `docker compose logs -f app` (add `tunnel`, `postgres`) |
| stop | `docker compose down` |
| start (no rebuild) | `docker compose --profile tunnel up -d` |
| rebuild after code change | `docker compose build app && docker compose --profile tunnel up -d` |

Data lives in the named volume `pgdata`. The `backups/` folder on the host is
mounted into the postgres container for convenient snapshot writes.

## 5. Backups

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

## 6. Upgrades

1. `git pull`
2. `docker compose build app`
3. `docker compose --profile tunnel up -d`

Migrations apply at boot, in order, each in its own transaction, then tenant
RLS is re-installed idempotently. Rolling back a schema change is not
supported: restore a backup instead.

## 7. Alternative ingress (if not using the tunnel)

Standard nginx + certbot is fine because Orbit terminates HTTP internally:

```
server {
  server_name orbit.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    # GitHub webhook bodies: larger than json defaults
    client_max_body_size 10m;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Host $host;
  }
}
```

With certbot: `sudo certbot --nginx -d orbit.example.com`.

## 8. Sizing

- 1 vCPU, 1 GB RAM runs a few dozen guilds comfortably; the Postgres pool
  caps at 10 connections and the scheduler at 4 concurrent jobs.
- Disk growth comes from events and deliveries; `RETENTION_DAYS` cleanup
  runs nightly (jobs: retention_cleanup).
