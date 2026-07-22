#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

for command_name in psql pg_dump pg_restore sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  fi
done

server_version_num="$(
  psql --dbname="$DATABASE_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
    --command='SHOW server_version_num'
)"
server_version_num="$(printf '%s' "$server_version_num" | tr -d '[:space:]')"
client_major="$(pg_dump --version | sed -n 's/^pg_dump (PostgreSQL) \([0-9][0-9]*\).*/\1/p')"
case "$server_version_num" in
  ""|*[!0-9]*)
    echo "Could not determine the PostgreSQL server major version" >&2
    exit 1
    ;;
esac
if [ -z "$client_major" ]; then
  echo "Could not determine the pg_dump major version" >&2
  exit 1
fi
server_major=$((server_version_num / 10000))
if [ "$client_major" -ne "$server_major" ]; then
  echo "PostgreSQL client/server major version mismatch: pg_dump $client_major, server $server_major" >&2
  exit 1
fi

BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-/var/backups/detective-archives}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

case "$BACKUP_DIRECTORY" in
  /*) ;;
  *)
    echo "BACKUP_DIRECTORY must be an absolute dedicated directory" >&2
    exit 1
    ;;
esac
case "$BACKUP_DIRECTORY/" in
  */../*|*/./*)
    echo "BACKUP_DIRECTORY must not contain dot path segments" >&2
    exit 1
    ;;
esac
case "$BACKUP_RETENTION_DAYS" in
  ""|*[!0-9]*)
    echo "BACKUP_RETENTION_DAYS must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "$BACKUP_RETENTION_DAYS" -lt 1 ]; then
  echo "BACKUP_RETENTION_DAYS must be at least 1" >&2
  exit 1
fi

umask 077
mkdir -p "$BACKUP_DIRECTORY"
BACKUP_DIRECTORY="$(CDPATH= cd "$BACKUP_DIRECTORY" && pwd -P)"
case "$BACKUP_DIRECTORY" in
  /|/home|/root|/var|/var/backups)
    echo "BACKUP_DIRECTORY must resolve to a dedicated subdirectory" >&2
    exit 1
    ;;
esac
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_file="$BACKUP_DIRECTORY/.detective-archives-$timestamp.dump.tmp"
final_file="$BACKUP_DIRECTORY/detective-archives-$timestamp.dump"
checksum_file="$final_file.sha256"
completed=false

if [ -e "$temporary_file" ] || [ -e "$final_file" ] || [ -e "$checksum_file" ]; then
  echo "Backup target already exists for timestamp $timestamp" >&2
  exit 1
fi

cleanup() {
  rm -f "$temporary_file"
  if [ "$completed" != true ]; then
    rm -f "$final_file" "$checksum_file"
  fi
}
trap cleanup EXIT INT TERM

pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --file="$temporary_file"
pg_restore --list "$temporary_file" >/dev/null
mv "$temporary_file" "$final_file"
(
  CDPATH= cd "$BACKUP_DIRECTORY"
  sha256sum "$(basename "$final_file")"
) >"$checksum_file"
completed=true
trap - EXIT INT TERM

find "$BACKUP_DIRECTORY" -type f -name 'detective-archives-*.dump' \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete
find "$BACKUP_DIRECTORY" -type f -name 'detective-archives-*.dump.sha256' \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete
find "$BACKUP_DIRECTORY" -type f -name 'detective-archives-*.dump.enc' \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete
find "$BACKUP_DIRECTORY" -type f -name 'detective-archives-*.dump.enc.sha256' \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete

echo "Backup completed: $final_file"
echo "Checksum recorded: $checksum_file"
