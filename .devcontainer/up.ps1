$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
& npx.cmd --yes '@devcontainers/cli@0.89.0' up --docker-path wslc --workspace-folder $workspace
if ($LASTEXITCODE -ne 0) { throw "Dev Container startup failed ($LASTEXITCODE)" }
