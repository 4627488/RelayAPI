# Agent Note: Serve rai from each RelayAPI deployment

Status: implemented

## Problem

The connection guide already hands out a site-hosted install script, but that script looked up `rai-<os>-<arch>` on GitHub Releases and otherwise required `go install`. This repository had no releases, `/releases/latest` would also collide with any future RelayAPI app tag, and a launcher downloaded from GitHub would not be guaranteed to match the contract of the site the user was signing into.

## Decision

The published image cross-compiles `rai` for darwin/linux/windows on amd64 and arm64 (`scripts/build-rai-dist.sh`) and copies them to `/rai-bin`. `RELAY_RAI_BIN_DIR` points the server at that directory (empty for a local `go run`). `GET /rai/download/{os}-{arch}` serves the matching file; `/.well-known/rai.json` advertises `download` and `rai_version`. The hosted install script downloads from that path on the same `PublicURL`, then runs `rai login`. `rai update` uses the logged-in profile (or `RAI_SERVER`) and the same site URL. Repo `scripts/install-rai.sh` is for developers: `RAI_SERVER` or `go install`.

## Alternatives considered

**Cut a one-off GitHub Release.** That unblocks a single download and then bit-rots. The next image publish would not refresh the launcher, and `/releases/latest` is the wrong source of truth for a self-hosted gateway.

**Automate GitHub Releases on every tag and keep them as the install source.** A second distribution channel still decouples the binary from the deployment the user is joining, and private or pinned sites would keep installing whatever GitHub currently calls latest.

**Embed the six binaries in the `relayapi` executable.** Image layout and `RELAY_RAI_BIN_DIR` keep the server binary small enough to `go run` without shipping clients.

## Consequences

A deployment that runs the published image can install and update `rai` without GitHub and without Go on the client. A local `go run` without `RELAY_RAI_BIN_DIR` returns 503 on `/rai/download`. Image size grows by the six launcher binaries.
