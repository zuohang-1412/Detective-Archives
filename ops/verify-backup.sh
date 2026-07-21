#!/bin/sh
set -eu

backup_file="${1:-}"
if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
  echo "Usage: $0 /absolute/path/to/detective-archives-TIMESTAMP.dump" >&2
  exit 1
fi

pg_restore --list "$backup_file" >/dev/null
checksum_file="$backup_file.sha256"
if [ -f "$checksum_file" ]; then
  backup_directory="$(CDPATH= cd "$(dirname "$backup_file")" && pwd -P)"
  (
    CDPATH= cd "$backup_directory"
    sha256sum --check "$(basename "$checksum_file")"
  )
fi
echo "Backup archive is readable: $backup_file"
