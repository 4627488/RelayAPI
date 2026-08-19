#!/usr/bin/env bash
# Per-boot startup for RelayAPI Cloud Agents. Brings the PostgreSQL 17 cluster
# online and ensures the relay role plus the relay/relay_test databases exist.
# Safe to run repeatedly.
set -euo pipefail

PG_VER=17

if ! sudo pg_ctlcluster "$PG_VER" main status >/dev/null 2>&1; then
  sudo pg_ctlcluster "$PG_VER" main start
fi

for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q; then
    break
  fi
  sleep 1
done

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
