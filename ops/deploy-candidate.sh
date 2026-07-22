#!/bin/sh
set -eu

if [ "${CANDIDATE_DEPLOYMENT:-}" != "true" ]; then
  echo "Set CANDIDATE_DEPLOYMENT=true for this isolated candidate deployment" >&2
  exit 1
fi

env_file="${1:-.env.candidate}"
if [ ! -f "$env_file" ]; then
  echo "Candidate environment file does not exist: $env_file" >&2
  exit 1
fi
case "$env_file" in
  */*) ;;
  *) env_file="./$env_file" ;;
esac

for command_name in docker curl flock stat; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required candidate deployment command is unavailable: $command_name" >&2
    exit 1
  fi
done

env_mode="$(stat -c '%a' "$env_file")"
case "$env_mode" in
  *00) ;;
  *)
    echo "Candidate environment file must not be readable or writable by group or other users" >&2
    exit 1
    ;;
esac

set -a
# The candidate file is a trusted, deployment-owned shell environment file.
. "$env_file"
set +a

for assignment in \
  "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-}" \
  "PGDATABASE=${PGDATABASE:-}" \
  "PGUSER=${PGUSER:-}" \
  "PGPASSWORD=${PGPASSWORD:-}" \
  "WECHAT_APP_ID=${WECHAT_APP_ID:-}" \
  "WECHAT_APP_SECRET=${WECHAT_APP_SECRET:-}" \
  "ADMIN_LOGIN_ID=${ADMIN_LOGIN_ID:-}" \
  "ADMIN_LOGIN_PASSWORD=${ADMIN_LOGIN_PASSWORD:-}" \
  "METRICS_AUTH_TOKEN=${METRICS_AUTH_TOKEN:-}" \
  "SOURCE_COMMIT=${SOURCE_COMMIT:-}" \
  "IMAGE_TAG=${IMAGE_TAG:-}"
do
  name="${assignment%%=*}"
  value="${assignment#*=}"
  if [ -z "$value" ]; then
    echo "Candidate environment is missing $name" >&2
    exit 1
  fi
done

case "$COMPOSE_PROJECT_NAME" in
  *candidate*|*staging*) ;;
  *)
    echo "COMPOSE_PROJECT_NAME must clearly identify a candidate or staging project" >&2
    exit 1
    ;;
esac
if [ -n "${DATABASE_URL:-}" ]; then
  echo "Candidate deployment must use its private Compose database, not DATABASE_URL" >&2
  exit 1
fi
if [ "${PGHOST:-}" != "database" ] || [ "${PGPORT:-}" != "5432" ]; then
  echo "Candidate PostgreSQL must use the private database:5432 service" >&2
  exit 1
fi
if [ "${PGSSLMODE:-}" != "disable" ]; then
  echo "Candidate PGSSLMODE must be disable inside the isolated Compose network" >&2
  exit 1
fi
if [ "${DETECTIVE_DB_NAME:-}" != "$PGDATABASE" ]; then
  echo "DETECTIVE_DB_NAME and PGDATABASE must identify the same candidate database" >&2
  exit 1
fi
case "$PGDATABASE" in
  ""|[!a-z]*|*[!a-z0-9_]*)
    echo "PGDATABASE must use lowercase letters, numbers and underscores" >&2
    exit 1
    ;;
  *) ;;
esac
if [ "${#PGDATABASE}" -gt 63 ]; then
  echo "PGDATABASE must not exceed 63 characters" >&2
  exit 1
fi
if [ "${WECHAT_DEV_LOGIN:-}" != "false" ]; then
  echo "Candidate deployment must keep WECHAT_DEV_LOGIN=false" >&2
  exit 1
fi
if [ "${#SOURCE_COMMIT}" -ne 40 ]; then
  echo "SOURCE_COMMIT must be a full 40-character Git commit" >&2
  exit 1
fi
case "$SOURCE_COMMIT" in
  *[!0-9a-fA-F]*)
    echo "SOURCE_COMMIT must be a full 40-character Git commit" >&2
    exit 1
    ;;
  *) ;;
esac
case "$IMAGE_TAG" in
  ""|*[!A-Za-z0-9._-]*|-*)
    echo "IMAGE_TAG contains unsupported characters" >&2
    exit 1
    ;;
esac

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

export API_ENV_FILE="$env_file"
umask 077
mkdir -p .release-state
exec 9>.release-state/candidate-deploy.lock
if ! flock -n 9; then
  echo "Another candidate deployment is already running" >&2
  exit 1
fi

compose() {
  docker compose \
    -f compose.yaml \
    -f ops/compose.candidate.yaml \
    --env-file "$env_file" \
    "$@"
}

echo "Validating isolated candidate configuration"
compose config --quiet

echo "Building detective-archives-api:$IMAGE_TAG"
compose build api

echo "Starting the private candidate database and API"
if ! compose up -d --no-build --wait --wait-timeout 180 database api; then
  compose logs --tail 100 database api >&2 || true
  exit 1
fi

api_container="$(compose ps -q api)"
database_container="$(compose ps -q database)"
if [ -z "$api_container" ] || [ -z "$database_container" ]; then
  echo "Candidate containers could not be resolved" >&2
  exit 1
fi

image_commit="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$api_container")"
if [ "$image_commit" != "$SOURCE_COMMIT" ]; then
  echo "Candidate image source revision does not match SOURCE_COMMIT" >&2
  exit 1
fi

published_api="$(docker port "$api_container" 3000/tcp)"
if [ "$published_api" != "127.0.0.1:$api_bind_port" ]; then
  echo "Candidate API must bind only to 127.0.0.1:$api_bind_port" >&2
  exit 1
fi
database_ports="$(docker port "$database_container" 2>/dev/null || true)"
if [ -n "$database_ports" ]; then
  echo "Candidate database must not publish a host port" >&2
  exit 1
fi
database_volume="$(docker inspect --format '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Type }}:{{ .Name }}{{ end }}{{ end }}' "$database_container")"
case "$database_volume" in
  volume:*) ;;
  *)
    echo "Candidate database must use a named persistent volume" >&2
    exit 1
    ;;
esac

runtime_base_url="http://127.0.0.1:$api_bind_port"
curl --fail --silent --show-error --max-time 10 "$runtime_base_url/ready" >/dev/null
compose exec -T -e RUNTIME_BASE_URL=http://127.0.0.1:3000 \
  api node scripts/check-runtime-smoke.mjs
compose exec -T -e RUNTIME_BASE_URL=http://127.0.0.1:3000 \
  api node scripts/check-runtime-performance.mjs

echo "Candidate deployment completed: $IMAGE_TAG on 127.0.0.1:$api_bind_port with a private persistent PostgreSQL 16 database"
