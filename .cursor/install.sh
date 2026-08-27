#!/usr/bin/env bash
# Idempotent repository bootstrap for RelayAPI Cloud Agents.
# Installs the PostgreSQL 17 server (missing from the base image) and refreshes
# Go module and web (pnpm) dependencies against the checked-out source.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. PostgreSQL 17 server (matches docker-compose and CI). Guarded so re-runs
#    are cheap once the PGDG package is already present.
if [ ! -d /usr/lib/postgresql/17 ]; then
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  . /etc/os-release
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-17
fi

# 2. Go dependencies.
go mod download

# 3. Web dependencies (pnpm via corepack, pinned to the CI version).
corepack enable
corepack prepare pnpm@11.24.0 --activate
(cd web && pnpm install --frozen-lockfile)

echo "install.sh completed"
