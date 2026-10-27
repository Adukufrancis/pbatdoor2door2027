#!/bin/sh
# One backup: pg_dump (custom format, compressed) -> /backups/daily, verified, then rotated.
# Sunday's backup is also kept in /backups/weekly. Uses PGHOST/PGUSER/PGPASSWORD/PGDATABASE.
#   Run by backup-loop.sh, or on demand: docker compose exec backup sh /scripts/backup-once.sh
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

umask 077
mkdir -p /backups/daily /backups/weekly
stamp="$(date -u +%Y%m%d-%H%M%S)"
out="/backups/daily/pbat-${stamp}.dump"
tmp="${out}.partial"

pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$tmp"
pg_restore --list "$tmp" > /dev/null          # fails if the archive is unreadable
mv "$tmp" "$out"
log "wrote $out ($(du -h "$out" | cut -f1))"

if [ "$(date -u +%u)" = "7" ]; then
  cp "$out" "/backups/weekly/"
  log "kept weekly copy"
fi

find /backups/daily -name 'pbat-*.dump' -mtime +"$((KEEP_DAYS - 1))" -print -delete | sed 's/^/removed /'
find /backups/daily -name '*.partial' -mmin +120 -delete
ls -1t /backups/weekly/pbat-*.dump 2>/dev/null | tail -n +"$((KEEP_WEEKLY + 1))" | while read -r f; do rm -f "$f"; echo "removed $f"; done
