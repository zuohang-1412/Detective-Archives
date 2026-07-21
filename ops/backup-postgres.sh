#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-/var/backups/detective-archives}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

case "$BACKUP_DIRECTORY" in
  /|/home|/root|/var|/var/backups)
    echo "BACKUP_DIRECTORY must be a dedicated subdirectory" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p "$BACKUP_DIRECTORY"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_file="$BACKUP_DIRECTORY/.detective-archives-$timestamp.dump.tmp"
final_file="$BACKUP_DIRECTORY/detective-archives-$timestamp.dump"

cleanup() {
  rm -f "$temporary_file"
}
trap cleanup EXIT INT TERM

pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --file="$temporary_file"
pg_restore --list "$temporary_file" >/dev/null
mv "$temporary_file" "$final_file"
trap - EXIT INT TERM

find "$BACKUP_DIRECTORY" -type f -name 'detective-archives-*.dump' \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete

echo "Backup completed: $final_file"
