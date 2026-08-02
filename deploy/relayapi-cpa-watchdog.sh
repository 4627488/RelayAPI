#!/usr/bin/env bash
set -u

state_file=/run/relayapi-cpa-watchdog.failures
health_url=http://127.0.0.1:18080/healthz
compose_dir=/opt/relayapi

payload=$(/usr/bin/curl --silent --show-error --max-time 8 "$health_url" 2>/dev/null || true)
if /usr/bin/jq --exit-status '.cpa == "ok" and .bridge.ready == true' >/dev/null 2>&1 <<<"$payload"; then
  /usr/bin/rm -f "$state_file"
  exit 0
fi

failures=0
if [[ -r "$state_file" ]]; then
  read -r failures <"$state_file" || failures=0
fi
if [[ ! "$failures" =~ ^[0-9]+$ ]]; then
  failures=0
fi
failures=$((failures + 1))
/usr/bin/printf '%s\n' "$failures" >"$state_file"

if (( failures < 2 )); then
  /usr/bin/logger -t relayapi-cpa-watchdog "health check failed (${failures}/2); waiting for confirmation"
  exit 0
fi

/usr/bin/logger -t relayapi-cpa-watchdog "CPA remained unhealthy; restarting cliproxyapi"
cd "$compose_dir" || exit 1
/usr/bin/docker compose restart cliproxyapi
/usr/bin/rm -f "$state_file"
