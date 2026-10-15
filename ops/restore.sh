#!/usr/bin/env bash
# TALABA AI restore into an EMPTY database and an empty storage directory.
# Usage:  ops/restore.sh <backup_dir> <target_database_url> <target_storage_dir>
# Then run:  pnpm --filter @talaba/server ops:reapply-deletions   (re-applies account deletions made after the backup)
set -euo pipefail
SRC="${1:?usage: restore.sh <backup_dir> <target_database_url> <target_storage_dir>}"
TARGET_DB="${2:?target database url}"
TARGET_STORAGE="${3:?target storage dir}"

(cd "$SRC" && sha256sum --quiet -c SHA256SUMS)
existing="$(psql "$TARGET_DB" -XAtc "select count(*) from pg_tables where schemaname = 'public'")"
if [ "$existing" != "0" ]; then echo "target database is not empty ($existing tables); refusing to restore" >&2; exit 2; fi
if [ -d "$TARGET_STORAGE" ] && [ -n "$(ls -A "$TARGET_STORAGE" 2>/dev/null)" ]; then echo "target storage dir is not empty; refusing" >&2; exit 2; fi

pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_DB" "$SRC/db.dump"
mkdir -p "$TARGET_STORAGE"
tar -C "$TARGET_STORAGE" -xzf "$SRC/storage.tar.gz"
diff <(psql "$TARGET_DB" -XAtc "select name from schema_migrations order by name") "$SRC/migrations.txt"
echo "restored $(basename "$SRC")"
