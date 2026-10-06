#!/bin/sh
# Restore a dump INTO A NAMED DATABASE (created fresh; refuses if it already exists).
#   restore.sh <dump-file> <target-db>
# Never restore over the live database while the app is running: restore to a new db, verify, then switch
# DATABASE_URL (or stop the stack first). Connection uses the PG* env vars.
set -eu
DUMP="${1:?usage: restore.sh <dump-file> <target-db>}"
TARGET="${2:?usage: restore.sh <dump-file> <target-db>}"
if psql -d postgres -tAc "select 1 from pg_database where datname='$TARGET'" | grep -q 1; then
  echo "refusing: database '$TARGET' already exists" >&2; exit 1
fi
createdb "$TARGET"
pg_restore --no-owner -d "$TARGET" "$DUMP"
echo "restored $DUMP into $TARGET"
