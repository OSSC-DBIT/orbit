#!/usr/bin/env bash
# ============================================================
# Orbit database backup script.
#
#   scripts/backup.sh [output_dir]
#
# Cron example (2:30 AM IST daily, keep 14):
#   30 2 * * * /opt/orbit/scripts/backup.sh /opt/orbit/backups >> /var/log/orbit-backup.log 2>&1
#
# Uses pg_dump inside the compose postgres container, or DATABASE_URL
# on bare metal. Output is gzip-compressed and timestamped; rotation
# by count (ORBIT_BACKUP_KEEP, default 14).
# ============================================================
set -euo pipefail

RETENTION_COUNT="${ORBIT_BACKUP_KEEP:-14}"
TS="$(date +%Y%m%d_%H%M%S)"
DEST="${1:-./backups}"

# work from the repository root so docker compose / .env resolve
cd "$(dirname "$0")/.."
mkdir -p "$DEST"

if docker compose exec -T postgres pg_isready >/dev/null 2>&1; then
  echo "[backup] found running compose postgres container"
  docker compose exec -T postgres bash -c \
    'pg_dump -U "$POSTGRES_USER" -Fc -d "$POSTGRES_DB"' > "$DEST/orbit_backup_${TS}.dump"
  FORMAT=custom
else
  # shellcheck disable=SC1091
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
  : "${DATABASE_URL:?DATABASE_URL must be set for bare metal backups}"
  echo "[backup] using DATABASE_URL (bare metal)"
  pg_dump -Fc "$DATABASE_URL" > "$DEST/orbit_backup_${TS}.dump"
  FORMAT=custom
fi

echo "[backup] wrote $DEST/orbit_backup_${TS}.dump (format: $FORMAT)"

ls -1t "$DEST"/orbit_backup_*.dump | tail -n +$((RETENTION_COUNT + 1)) | xargs -r rm -f
echo "[backup] rotation kept the newest $RETENTION_COUNT"
