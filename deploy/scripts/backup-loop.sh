#!/bin/sh
# Runs backup.sh now and then every BACKUP_INTERVAL_HOURS. A failed run is logged, sent to ALERT_WEBHOOK_URL
# (if set) and retried at the next interval.
INTERVAL="${BACKUP_INTERVAL_HOURS:-24}"
while true; do
  if ! sh /scripts/backup.sh; then
    MSG="AK VisionFlow BACKUP FAILED at $(date -u +%FT%TZ)"
    echo "$MSG" >&2
    [ -n "${ALERT_WEBHOOK_URL:-}" ] && wget -q -T 5 -O /dev/null --header 'Content-Type: application/json' \
      --post-data "{\"text\":\"$MSG\",\"content\":\"$MSG\"}" "$ALERT_WEBHOOK_URL" || true
  fi
  sleep $((INTERVAL * 3600))
done
