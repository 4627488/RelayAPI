#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir=${RELAYAPI_DEPLOY_DIR:-/opt/relayapi}
compose_file=${RELAYAPI_COMPOSE_FILE:-compose.yml}
health_url=${RELAYAPI_HEALTH_URL:-http://127.0.0.1:18080/healthz}
target_image=${1:-}

if [[ ! "$target_image" =~ ^ghcr\.io/4627488/relayapi:(sha-[0-9a-f]{7,40}|v?[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo "Refusing invalid RelayAPI image: $target_image" >&2
  exit 2
fi

cd "$deploy_dir"
exec 9>./.deploy.lock
flock -n 9 || { echo "Another RelayAPI deployment is running" >&2; exit 3; }

old_image=$(docker inspect relayapi-relayapi-1 --format '{{.Config.Image}}' 2>/dev/null || true)
if [[ -z "$old_image" ]]; then
  old_image=$(awk '/^  relayapi:/{service=1; next} service && /^    image:/{print $2; exit} service && /^  [^ ]/{exit}' "$compose_file")
fi
if [[ -z "$old_image" ]]; then
  echo "Cannot determine the currently deployed RelayAPI image" >&2
  exit 4
fi

set_compose_image() {
  local image=$1
  sed -i -E "/^  relayapi:/,/^  [^ ]/ s#^    image: .*$#    image: ${image}#" "$compose_file"
  docker compose -f "$compose_file" config --quiet
}

healthy() {
  for _ in $(seq 1 45); do
    if curl --fail --silent --show-error "$health_url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  echo "Deployment failed; rolling back to $old_image" >&2
  set_compose_image "$old_image"
  docker compose -f "$compose_file" up -d --no-deps --force-recreate relayapi
  if ! healthy; then
    docker compose -f "$compose_file" logs --tail=150 relayapi >&2
    echo "Rollback health check failed" >&2
    return 1
  fi
  echo "Rollback completed"
}

backup="${compose_file}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$compose_file" "$backup"

echo "Pulling $target_image"
docker pull "$target_image"
set_compose_image "$target_image"

if ! docker compose -f "$compose_file" up -d --no-deps --force-recreate relayapi; then
  rollback
  exit 1
fi
if ! healthy; then
  docker compose -f "$compose_file" logs --tail=150 relayapi >&2
  rollback
  exit 1
fi

docker compose -f "$compose_file" ps relayapi
echo "RelayAPI deployed: $old_image -> $target_image"
