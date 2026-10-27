#!/usr/bin/env bash
# Restores a pg_dump backup into the running stack, replacing the current database.
#   Usage (from the repo directory): scripts/restore.sh backups/daily/pbat-YYYYMMDD-HHMMSS.dump
# A safety backup of the current database is taken first.
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:-}"
[ -f "$file" ] || { echo "Usage: $0 <path-to-.dump>" >&2; exit 1; }
set -a; [ -f .env ] && . ./.env; set +a
DB="${POSTGRES_DB:-pbat}"; USER_="${POSTGRES_USER:-pbat}"

read -r -p "This REPLACES database '$DB' with $file. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "Cancelled."; exit 1; }

echo "Safety backup of the current database..."
mkdir -p "${BACKUP_DIR:-./backups}"
(umask 077; docker compose exec -T db pg_dump -U "$USER_" -d "$DB" --format=custom \
  > "${BACKUP_DIR:-./backups}/pre-restore-$(date -u +%Y%m%d-%H%M%S).dump")

echo "Stopping the app..."
docker compose stop app

echo "Recreating the database and restoring..."
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$USER_" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" -c "CREATE DATABASE \"$DB\" OWNER \"$USER_\";"
docker compose exec -T db pg_restore -U "$USER_" -d "$DB" --no-owner --no-privileges --exit-on-error < "$file"

echo "Starting the app (it applies any newer migrations on start)..."
docker compose up -d app
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT:-3000}/readyz" > /dev/null 2>&1; then echo "Restore complete."; exit 0; fi
  sleep 2
done
echo "The app did not become ready; check: docker compose logs app" >&2
exit 1
