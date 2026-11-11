# RelayAPI distribution

The standard deployment contains only RelayAPI and PostgreSQL. The Relay image
includes the Go API, native provider runtime, built React application, and the
`rai` launcher binaries for darwin/linux/windows on amd64 and arm64. No
sidecar proxy, bridge image, C ABI plugin or third-party executor module is
required. The site serves those binaries at `/rai/download/{os}-{arch}` so
each deployment installs a launcher that matches that image.

CI publishes Linux AMD64/ARM64 images. Production should pin a full release or
immutable `sha-<full commit SHA>` tag. The deployment workflow verifies
`/healthz` and rolls back to the prior image if the new instance fails readiness.

```bash
docker compose pull
docker compose up -d
```

Persistent state is the PostgreSQL volume plus the secrets in `.env`. Back up
`RELAY_API_KEY_ENCRYPTION_KEY`; changing it prevents existing encrypted
credential and API-key material from being opened.

## Build and release pipeline

PR image builds run alongside the checks. Main-branch releases compile the
server on native AMD64/ARM64 runners, and build the frontend and six-platform
launcher distribution once for both images. Module caches follow dependency
locks. Compilation caches are isolated by job, architecture and toolchain,
refreshed per commit, and restored across commits. The Docker build only assembles these artifacts
and the pinned Cursor runtime (`BUILD_SOURCE=prebuilt`). Ordinary `docker build .`
continues to build everything from source.

Launcher versions use a hash of the actual non-test source/embedded inputs for
all six target platforms, dependency locks, build script and Go toolchain.
Unrelated API/UI changes therefore do not force a launcher update. `-trimpath`
and `-buildvcs=false` avoid checkout-specific build metadata. Independent Docker
COPY layers preserve unchanged launcher assets when the API binary changes.

Compilation and checks overlap, but mutable/release/SHA image tags are only
published after CI passes for the exact commit. Main pushes wait for their
existing push CI; tags and manual publications invoke the reusable CI workflow.
An absent, failed or cancelled CI run blocks publication. Unverified image
digests may exist in GHCR, but are not tagged for deployment.

Both deployment workflows use the full commit SHA and stream the matching
repository deployment script over SSH, so no manual server-script update is
needed. Manual deployment requires an explicit existing SHA or version tag;
this also supports rollback to a previously published release. The script
retains the deployment lock, pulls before replacing the container, skips a
restart when the requested image is already running and healthy, and rolls
back on startup/readiness failure. It discovers the Compose service container
rather than assuming a production container name.

Deployment logs report pull duration, uncompressed image size, and container
replacement/readiness duration separately. Compare warm-cache runs with the
same kind of change; the first run has to populate the new release caches.
Slow pulls should be investigated separately from startup time before adding
a registry mirror or changing the server network.

Run `python scripts/test_deploy.py` for isolated deployment failure/rollback
checks (requires Linux/Bash; on Windows run it through WSL). Run `actionlint`
for workflow validation. Full image assembly requires a Linux Docker daemon.
