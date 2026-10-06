#!/bin/sh
# Restore-test: restore the newest dump into a scratch database, compare row counts of every table with the
# source database, then drop the scratch database. Exit 0 only if at least one table was compared, no query
# failed, and every table's row count matches. (Rows written after the backup show up as a mismatch.)
set -eu
BACKUP_DIR="${BACKUP_DIR:-/backups}"
SRC="${PGDATABASE:?PGDATABASE (source db) required}"
SCRATCH="restore_verify_$$"
LATEST="$(ls -1t "$BACKUP_DIR"/akvf-*.dump 2>/dev/null | head -1 || true)"
[ -n "$LATEST" ] || { echo "no backup found in $BACKUP_DIR" >&2; exit 1; }
TMP="${TMPDIR:-/tmp}"

# One query returns "table|rowcount" for every public table; ON_ERROR_STOP makes any failure fatal.
COUNT_SQL="select table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
           from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
counts() { psql -v ON_ERROR_STOP=1 -d "$1" -tA -c "$COUNT_SQL" | tr -d '\r'; }

sh "$(dirname "$0")/restore.sh" "$LATEST" "$SCRATCH"
cleanup() { dropdb --if-exists "$SCRATCH" 2>/dev/null || true; rm -f "$TMP/src.$$" "$TMP/rst.$$"; }
trap cleanup EXIT

counts "$SRC" > "$TMP/src.$$"
counts "$SCRATCH" > "$TMP/rst.$$"
N="$(wc -l < "$TMP/rst.$$" | tr -d ' ')"
[ "$N" -gt 0 ] || { echo "RESTORE NOT VERIFIED: no tables found in restored database" >&2; exit 3; }

if diff "$TMP/src.$$" "$TMP/rst.$$" >/dev/null; then
  ROWS="$(awk -F'|' '{s+=$2} END {print s}' "$TMP/rst.$$")"
  echo "RESTORE VERIFIED: $N tables, $ROWS total rows, every count identical ($LATEST)"
else
  echo "RESTORE MISMATCH (< source, > restored):"; diff "$TMP/src.$$" "$TMP/rst.$$" || true
  exit 2
fi
