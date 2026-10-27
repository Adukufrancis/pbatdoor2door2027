#!/bin/sh
# Runs inside the `backup` container: a nightly pg_dump at BACKUP_TIME_UTC (HH:MM, UTC).
# Also takes one at startup if there's no backup from the last 24 hours.
set -eu

BACKUP_TIME_UTC="${BACKUP_TIME_UTC:-01:30}"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

last_run_day=""
if [ -z "$(find /backups -maxdepth 2 -name 'pbat-*.dump' -mmin -1440 2>/dev/null | head -n 1)" ]; then
  log "no backup in the last 24h, taking one now"
  /bin/sh /scripts/backup-once.sh || log "startup backup FAILED"
fi

log "scheduled daily at ${BACKUP_TIME_UTC} UTC, keeping ${BACKUP_KEEP_DAYS:-14} daily and ${BACKUP_KEEP_WEEKLY:-8} weekly"
while true; do
  now_hm="$(date -u +%H:%M)"
  today="$(date -u +%Y-%m-%d)"
  if [ "$now_hm" = "$BACKUP_TIME_UTC" ] && [ "$last_run_day" != "$today" ]; then
    last_run_day="$today"
    /bin/sh /scripts/backup-once.sh || log "nightly backup FAILED"
  fi
  sleep 20
done
