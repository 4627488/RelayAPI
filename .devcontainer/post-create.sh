#!/usr/bin/env bash
set -euo pipefail

sudo chown -R node:node /home/node/go /home/node/.cache
git config core.autocrlf input
go mod download
(cd third_party/cpaexecutor && go mod download)
pnpm --dir web install --frozen-lockfile
pnpm --dir web exec playwright install --with-deps chromium
