#!/bin/sh
set -eu

requested_tag="${1:-}"
env_file="${2:-${API_ENV_FILE:-.env.production}}"
state_directory="${RELEASE_STATE_DIRECTORY:-.release-state}"

if [ -z "$requested_tag" ] && [ -f "$state_directory/previous-image-tag" ]; then
  requested_tag="$(sed -n '1p' "$state_directory/previous-image-tag")"
fi

case "$requested_tag" in
  ""|*[!A-Za-z0-9._-]*|-*)
    echo "Usage: $0 [previous-image-tag] [production-env-file]" >&2
    exit 1
    ;;
esac

if [ ! -f "$env_file" ]; then
  echo "Production environment file does not exist: $env_file" >&2
  exit 1
fi
case "$env_file" in
  */*) ;;
  *) env_file="./$env_file" ;;
esac

case "$state_directory" in
  ""|/|.)
    echo "RELEASE_STATE_DIRECTORY must be a dedicated directory" >&2
    exit 1
    ;;
esac

for command_name in docker curl npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  fi
done

if ! docker image inspect "detective-archives-api:$requested_tag" >/dev/null 2>&1; then
  echo "Rollback image is not available locally: detective-archives-api:$requested_tag" >&2
  exit 1
fi

wait_until_ready() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if curl --fail --silent --show-error --max-time 5 "$runtime_base_url/ready" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

service_id="$(API_ENV_FILE="$env_file" docker compose ps -q api 2>/dev/null || true)"
current_tag=""
if [ -n "$service_id" ]; then
  current_image="$(docker inspect --format '{{.Config.Image}}' "$service_id")"
  case "$current_image" in
    detective-archives-api:*) current_tag="${current_image#detective-archives-api:}" ;;
  esac
fi

set -a
# The production file is a trusted, deployment-owned shell environment file.
. "$env_file"
set +a

api_bind_port="${API_BIND_PORT:-3000}"
case "$api_bind_port" in
  ""|*[!0-9]*)
    echo "API_BIND_PORT must be an integer between 1 and 65535" >&2
    exit 1
    ;;
esac
if [ "$api_bind_port" -lt 1 ] || [ "$api_bind_port" -gt 65535 ]; then
  echo "API_BIND_PORT must be an integer between 1 and 65535" >&2
  exit 1
fi
runtime_base_url="http://127.0.0.1:$api_bind_port"

echo "Rolling back application to detective-archives-api:$requested_tag"
API_ENV_FILE="$env_file" IMAGE_TAG="$requested_tag" docker compose up -d --no-build api

rollback_ok=true
if ! wait_until_ready; then
  rollback_ok=false
elif ! RUNTIME_BASE_URL="$runtime_base_url" \
  METRICS_AUTH_TOKEN="$METRICS_AUTH_TOKEN" npm run check:runtime; then
  rollback_ok=false
fi

if [ "$rollback_ok" != true ]; then
  echo "Rollback target failed verification" >&2
  if [ -n "$current_tag" ] && [ "$current_tag" != "$requested_tag" ] && \
    docker image inspect "detective-archives-api:$current_tag" >/dev/null 2>&1; then
    echo "Restoring the application image that was active before rollback: $current_tag" >&2
    API_ENV_FILE="$env_file" IMAGE_TAG="$current_tag" docker compose up -d --no-build api
    if wait_until_ready; then
      RUNTIME_BASE_URL="$runtime_base_url" \
        METRICS_AUTH_TOKEN="$METRICS_AUTH_TOKEN" npm run check:runtime || true
    fi
  fi
  exit 1
fi

umask 077
mkdir -p "$state_directory"
if [ -n "$current_tag" ] && [ "$current_tag" != "$requested_tag" ]; then
  printf '%s\n' "$current_tag" >"$state_directory/previous-image-tag"
fi
printf '%s\n' "$requested_tag" >"$state_directory/current-image-tag"

echo "Rollback completed: detective-archives-api:$requested_tag"
