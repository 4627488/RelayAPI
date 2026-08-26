# Agent Note: Ship the rai agent launcher

Status: implemented

## Problem

RelayAPI already gives Codex and OpenCode a complete gateway contract and a five-minute connection guide that writes durable client configuration, while each coding-agent CLI also carries its own provider selection, authentication, model discovery, feature flags, and configuration precedence. Users who work across several agents need one Relay-aware entry point that signs in once, selects a permitted model, prepares the matching client contract for that launch, and preserves the agent's familiar command line.

## Decision

Ship `rai` from `cmd/rai` with reusable code in `internal/rai`. The launcher follows the Ori Harness shape: browser PKCE login, per-launch adapters for the real agent CLIs on `PATH`, `--model` passthrough, missing-binary install hints, and `rai update`.

`rai login --server <url>` starts a PKCE S256 device grant (`POST /api/rai/authorizations`), opens `/rai/authorize/{id}` (or prints it with `--no-browser`), and polls `POST /api/rai/token`. Approval uses the existing tenant session; the page can collect email/password when the browser is not already signed in. A successful approve creates a recoverable API key named `rai · <device>`. `--api-key-stdin` remains for CI and already-issued keys. `RAI_SERVER` supplies the server URL when `--server` is omitted; launching without a profile starts the same login when that variable is set.

Credentials prefer the OS keyring (`zalando/go-keyring` with a 3s timeout) and write `~/.config/rai/credentials.json` at `0600` when the keyring is unavailable or `RAI_DISABLE_KEYRING=1`. Config writes are atomic in the same directory. Child processes inherit stdio; the parent ignores SIGINT so the terminal delivers it to the shared process group; `rai` returns the child's exit code.

Adapters: Claude Code (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`, model-aware `ENABLE_TOOL_SEARCH`), Codex (`-c` overrides plus `rai credential print`), OpenCode (`OPENCODE_CONFIG_CONTENT`), Grok / Hermes / Pi / Prime Agent (OpenAI-compatible env, Grok also sets `XAI_*`). `scripts/install-rai.sh` and `scripts/install-rai.ps1` install from GitHub Releases, then `go install`.

## Alternatives considered

**Continue growing the generated connection scripts.** The scripts remain for durable Codex and OpenCode configuration. `rai` adds browser login, per-launch model choice, and more agents.

**Publish `rai` from a dedicated repository.** The RelayAPI repository keeps server discovery, the authorize page, adapters, and tests in one change.

**Build the launcher in TypeScript.** Go matches the existing toolchain and produces a single executable.

**Localhost OAuth callback.** Device authorization plus a same-origin approve page matches headless `--no-browser` and the Ori “open this URL” path without binding a loopback port.

## Consequences

Users can `rai login --server <url>`, approve in the browser, then `rai claude` / `rai codex` / `rai opencode` (and the other adapters) against a live RelayAPI deployment. CI builds both `./cmd/relayapi` and `./cmd/rai`. Follow-on work: release assets named `rai-<os>-<arch>` so `rai update` and the installers can download binaries, plus server-delivered launch recommendations.
