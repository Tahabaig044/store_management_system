#!/bin/sh
# One backup: custom-format pg_dump (compressed), then prune files older than BACKUP_RETENTION_DAYS.
# Connection comes from the standard PG* env vars (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
set -eu
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/akvf-$STAMP.dump"
pg_dump -Fc --no-owner -f "$OUT.partial"
mv "$OUT.partial" "$OUT"
find "$BACKUP_DIR" -name 'akvf-*.dump' -mtime +"$RETENTION" -delete
echo "backup ok: $OUT ($(wc -c < "$OUT") bytes)"
