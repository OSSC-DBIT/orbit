#!/usr/bin/env bash
# ============================================================
# Orbit database restore script.
#
#   scripts/restore.sh backups/orbit_backup_YYYYMMDD_HHMMSS.dump
#
# DANGER: replaces the entire database contents. Stop the app first:
#   docker compose stop app
# ============================================================
set -euo pipefail

FILE="${1:?usage: scripts/restore.sh <orbit_backup_*.dump>}"
[ -f "$FILE" ] || { echo "backup file not found: $FILE" >&2; exit 1; }

cd "$(dirname "$0")/.."

if docker compose exec -T postgres pg_isready >/dev/null 2>&1; then
  echo "[restore] streaming $FILE into the compose postgres..."
  cat "$FILE" | docker compose exec -T postgres bash -c \
    'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'
else
  # shellcheck disable=SC1091
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
  : "${DATABASE_URL:?DATABASE_URL must be set for bare metal restores}"
  echo "[restore] streaming $FILE into DATABASE_URL target..."
  pg_restore --clean --if-exists -d "$DATABASE_URL" "$FILE"
fi

echo "[restore] done. bring the app back up with: docker compose start app"
