#!/usr/bin/env bash
# TALABA AI backup: database (pg_dump custom format) + private file storage, with checksums.
# Usage:  DATABASE_URL=... STORAGE_DIR=... ops/backup.sh <backup_root> [retention_days]
# Prints the new backup directory. Backups older than retention_days (default 14) are removed.
set -euo pipefail
ROOT="${1:?usage: backup.sh <backup_root> [retention_days]}"
RETENTION_DAYS="${2:-${BACKUP_RETENTION_DAYS:-14}}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${STORAGE_DIR:?STORAGE_DIR is required}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$ROOT/talaba-$STAMP"
mkdir -p "$DEST"
umask 077

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$DEST/db.dump"
tar -C "$STORAGE_DIR" -czf "$DEST/storage.tar.gz" .
psql "$DATABASE_URL" -XAtc "select name from schema_migrations order by name" > "$DEST/migrations.txt"
{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "pg_dump=$(pg_dump --version)"
  echo "db_bytes=$(stat -c %s "$DEST/db.dump")"
  echo "storage_bytes=$(stat -c %s "$DEST/storage.tar.gz")"
} > "$DEST/manifest.txt"
(cd "$DEST" && sha256sum db.dump storage.tar.gz migrations.txt manifest.txt > SHA256SUMS)

# rotation: deleted accounts disappear from backups once these expire
find "$ROOT" -maxdepth 1 -type d -name 'talaba-*' -mtime "+$RETENTION_DAYS" -exec rm -rf {} +
echo "$DEST"
