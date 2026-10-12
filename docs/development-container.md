# Local development with WSLC

This Windows workflow uses WSL Containers and the standard Dev Containers
configuration. Docker Compose is not required: the initialization script starts
a PostgreSQL sidecar on a private development network.

Requirements: WSL 2.9.3 or later with `wslc`, Node.js/npm on Windows, and optionally
VS Code with the Dev Containers extension. The CLI is pinned to version 0.89.0.

From the Windows checkout, run:

```powershell
powershell -ExecutionPolicy Bypass -File .devcontainer/up.ps1
```

The first run copies tracked files, Git metadata and the development container
configuration into the `relayapi-dev-workspace` Linux volume. Subsequent starts
preserve that workspace. Edit the container workspace through VS Code or `wslc
exec`; changes do not automatically synchronize with the Windows checkout. Use
Git to commit/push from the container and pull into the Windows checkout.

For VS Code, set the user setting `dev.containers.dockerPath` to `wslc`, then open
the Windows checkout and select **Dev Containers: Reopen in Container**. The
container opens `/workspaces/RelayAPI` from the Linux volume. This driver setting
applies to all Dev Containers on that local VS Code installation.

Go 1.26.6, Node.js 24, pnpm 11.24.0, a C compiler, PostgreSQL client and Chromium
are installed. Go modules and browser/dependency caches persist in named volumes.
Random local credentials are generated in `.devcontainer/.env.local`, which is
Git-ignored. `relay_dev` is the application database; `relay_test` is used only
by integration tests. The development PostgreSQL port is not published to Windows.

Start the backend and frontend in two container terminals:

```bash
go run ./cmd/relayapi
pnpm --dir web dev --host 0.0.0.0
```

The frontend is at <http://localhost:5173> and the API at <http://localhost:3000>.
Both published ports bind only to Windows localhost.

Run validation inside the container:

```bash
go test -race -count=1 ./...
go vet ./...
(cd third_party/cpaexecutor && go test -race -count=1 ./... && go vet ./...)
pnpm --dir web check
```

Or execute a command from PowerShell:

```powershell
wslc exec -u node -w /workspaces/RelayAPI relayapi-dev go test ./...
wslc exec -it -u node -w /workspaces/RelayAPI relayapi-dev bash
wslc stop relayapi-dev relayapi-dev-postgres
```

Stopping containers preserves source, caches and PostgreSQL data. Rebuilding
the image also preserves these named volumes. Do not remove the workspace volume
while it contains uncommitted work. Keep `.env.local` with the PostgreSQL volume;
regenerating its password does not change an existing database's password.

References: [Microsoft's WSLC tutorial](https://learn.microsoft.com/en-us/windows/wsl/tutorials/wsl-containers),
[WSLC Dev Containers support](https://github.com/devcontainers/cli/pull/1249).
