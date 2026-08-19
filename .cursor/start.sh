#!/usr/bin/env bash
# Per-boot startup for RelayAPI Cloud Agents. Brings the PostgreSQL 17 cluster
# online and ensures the relay role plus the relay/relay_test databases exist.
# Safe to run repeatedly and robust to a stale postmaster.pid left behind when a
# snapshot is captured while PostgreSQL is running.
set -euo pipefail

PG_VER=17
PGDATA="/var/lib/postgresql/${PG_VER}/main"

pg_ready() { sudo -u postgres pg_isready -q -h 127.0.0.1 -p 5432; }

if ! pg_ready; then
  # pg_isready is the authoritative "accepting connections" check. If it fails,
  # any postmaster.pid is stale (e.g. inherited from a snapshot) and blocks
  # startup, so remove it before starting the cluster.
  if [ -f "${PGDATA}/postmaster.pid" ]; then
    sudo rm -f "${PGDATA}/postmaster.pid"
  fi
  sudo pg_ctlcluster "$PG_VER" main start
  for _ in $(seq 1 30); do
    if pg_ready; then
      break
    fi
    sleep 1
  done
fi

if ! pg_ready; then
  echo "start.sh: PostgreSQL 17 failed to accept connections" >&2
  exit 1
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'relay') THEN
    CREATE ROLE relay LOGIN PASSWORD 'relay' SUPERUSER;
  END IF;
END
$$;
SQL

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'relay'" \
  | grep -q 1 || sudo -u postgres createdb -O relay relay
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'relay_test'" \
  | grep -q 1 || sudo -u postgres createdb -O relay relay_test

echo "start.sh completed: PostgreSQL 17 online with relay/relay_test databases"
