#!/bin/sh
set -eu

release_tag="${1:-}"
env_file="${2:-${API_ENV_FILE:-.env.production}}"
state_directory="${RELEASE_STATE_DIRECTORY:-.release-state}"

usage() {
  echo "Usage: $0 <image-tag> [production-env-file]" >&2
  exit 1
}

case "$release_tag" in
  ""|*[!A-Za-z0-9._-]*|-*) usage ;;
esac

if [ ! -f "$env_file" ]; then
  echo "Production environment file does not exist: $env_file" >&2
  exit 1
fi
case "$env_file" in
  */*) ;;
  *) env_file="./$env_file" ;;
esac

for command_name in docker curl npm psql pg_dump pg_restore sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  fi
done

case "$state_directory" in
  ""|/|.)
    echo "RELEASE_STATE_DIRECTORY must be a dedicated directory" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p "$state_directory"

wait_until_ready() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/ready >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

service_id="$(API_ENV_FILE="$env_file" docker compose ps -q api 2>/dev/null || true)"
previous_image=""
previous_tag=""
if [ -n "$service_id" ]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$service_id")"
  case "$previous_image" in
    detective-archives-api:*) previous_tag="${previous_image#detective-archives-api:}" ;;
  esac
fi

set -a
# The production file is a trusted, deployment-owned shell environment file.
. "$env_file"
set +a

echo "Running release checks for $release_tag"
npm run release:check

echo "Creating the mandatory pre-deployment database backup"
sh ops/backup-postgres.sh

echo "Building detective-archives-api:$release_tag"
API_ENV_FILE="$env_file" IMAGE_TAG="$release_tag" docker compose build api

echo "Starting detective-archives-api:$release_tag"
if ! API_ENV_FILE="$env_file" IMAGE_TAG="$release_tag" docker compose up -d --no-build api; then
  echo "The new application image could not be started" >&2
  if [ -n "$previous_tag" ] && docker image inspect "detective-archives-api:$previous_tag" >/dev/null 2>&1; then
    echo "Restoring previous application image: $previous_tag" >&2
    API_ENV_FILE="$env_file" IMAGE_TAG="$previous_tag" docker compose up -d --no-build api || true
  fi
  exit 1
fi

release_ok=true
if ! wait_until_ready; then
  release_ok=false
elif ! npm run check:db; then
  release_ok=false
elif ! RUNTIME_BASE_URL=http://127.0.0.1:3000 \
  METRICS_AUTH_TOKEN="$METRICS_AUTH_TOKEN" npm run check:runtime; then
  release_ok=false
fi

if [ "$release_ok" != true ]; then
  echo "Release verification failed for $release_tag" >&2
  if [ -n "$previous_tag" ] && docker image inspect "detective-archives-api:$previous_tag" >/dev/null 2>&1; then
    echo "Restoring previous application image: $previous_tag" >&2
    API_ENV_FILE="$env_file" IMAGE_TAG="$previous_tag" docker compose up -d --no-build api
    if ! wait_until_ready || ! npm run check:db || \
      ! RUNTIME_BASE_URL=http://127.0.0.1:3000 \
        METRICS_AUTH_TOKEN="$METRICS_AUTH_TOKEN" npm run check:runtime; then
      echo "Automatic rollback also failed readiness checks" >&2
    fi
  else
    echo "No previous local application image is available for automatic rollback" >&2
  fi
  exit 1
fi

if [ -n "$previous_tag" ] && [ "$previous_tag" != "$release_tag" ]; then
  printf '%s\n' "$previous_tag" >"$state_directory/previous-image-tag"
fi
printf '%s\n' "$release_tag" >"$state_directory/current-image-tag"

echo "Release completed: detective-archives-api:$release_tag"
if [ -n "$previous_tag" ] && [ "$previous_tag" != "$release_tag" ]; then
  echo "Rollback target recorded: detective-archives-api:$previous_tag"
fi
