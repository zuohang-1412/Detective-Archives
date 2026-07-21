#!/bin/sh
set -eu

backup_file="${1:-}"
if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
  echo "Usage: $0 /absolute/path/to/detective-archives-TIMESTAMP.dump" >&2
  exit 1
fi

pg_restore --list "$backup_file" >/dev/null
echo "Backup archive is readable: $backup_file"
