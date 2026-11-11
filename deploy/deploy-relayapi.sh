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

container_id=$(docker compose -f "$compose_file" ps -q relayapi)
old_image=$(docker inspect "${container_id:-missing}" --format '{{.Config.Image}}' 2>/dev/null || true)
if [[ -z "$old_image" ]]; then
  old_image=$(awk '/^  relayapi:/{service=1; next} service && /^    image:/{print $2; exit} service && /^  [^ ]/{exit}' "$compose_file")
fi
if [[ -z "$old_image" ]]; then
  echo "Cannot determine the currently deployed RelayAPI image" >&2
  exit 4
fi

set_compose_image() {
  local image=$1
  sed -i -E "/^  relayapi:/,/^  [^ ]/ s#^    image: .*\$#    image: ${image}#" "$compose_file"
  docker compose -f "$compose_file" config --quiet
}

healthy() {
  for _ in $(seq 1 45); do
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$health_url" >/dev/null; then
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
pull_started=$SECONDS
docker pull "$target_image"
echo "Image pull completed in $((SECONDS - pull_started))s"
docker image inspect "$target_image" --format 'Image={{.Id}} UncompressedBytes={{.Size}}'
set_compose_image "$target_image"

# Re-running a deployment should not interrupt an already healthy instance.
running_id=$(docker inspect "${container_id:-missing}" --format '{{.Image}}' 2>/dev/null || true)
target_id=$(docker image inspect "$target_image" --format '{{.Id}}')
if [[ "$running_id" == "$target_id" ]] && \
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$health_url" >/dev/null; then
  echo "RelayAPI already runs the requested image and is healthy; skipping restart"
  exit 0
fi

restart_started=$SECONDS
if ! docker compose -f "$compose_file" up -d --no-deps --force-recreate relayapi; then
  rollback
  exit 1
fi
if ! healthy; then
  docker compose -f "$compose_file" logs --tail=150 relayapi >&2
  rollback
  exit 1
fi

echo "Container replacement and readiness completed in $((SECONDS - restart_started))s"
docker compose -f "$compose_file" ps relayapi
echo "RelayAPI deployed: $old_image -> $target_image"
