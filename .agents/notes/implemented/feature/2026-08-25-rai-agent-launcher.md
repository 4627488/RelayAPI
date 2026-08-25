# Agent Note: Ship the rai agent launcher

Status: implemented

## Problem

RelayAPI already gives Codex and OpenCode a complete gateway contract and a five-minute connection guide that writes durable client configuration, while each coding-agent CLI also carries its own provider selection, authentication, model discovery, feature flags, and configuration precedence. Users who work across several agents need one Relay-aware entry point that signs in once, selects a permitted model, prepares the matching client contract for that launch, and preserves the agent's familiar command line.

## Decision

Ship `rai` from `cmd/rai` with reusable code in `internal/rai`. Milestone 1 is in this change: `--api-key-stdin` enrollment, profile and credential storage, Codex and OpenCode adapters, `models` / `status` / `doctor` / `credential print`, plus server discovery at `GET /.well-known/rai.json` and authenticated `GET /api/rai/session`.

The CLI uses `--profile`, `RAI_PROFILE`, then the active profile. Credentials prefer the OS keyring (`zalando/go-keyring` with a 3s timeout) and write `~/.config/rai/credentials.json` at `0600` when the keyring is unavailable or `RAI_DISABLE_KEYRING=1`. Config writes are atomic in the same directory. Child processes inherit stdio; the parent ignores SIGINT so the terminal delivers it to the shared process group; `rai` returns the child's exit code.

The Codex adapter passes `-c` overrides for the Relay provider, Responses wire API, WebSocket and search flags, model, reasoning effort, `RAI_API_KEY`, and `rai --profile <name> credential print` as command-based auth. The OpenCode adapter sets `OPENCODE_CONFIG_CONTENT` with the Relay provider block and `{env:RAI_API_KEY}`.

Device authorization, browser approval, self-update, installers, and additional adapters remain the next milestones in the original proposal.

## Alternatives considered

**Continue growing the generated connection scripts.** The scripts remain for durable Codex and OpenCode configuration. `rai` adds per-launch model choice, client-version-aware settings, and a shared credential workflow.

**Publish `rai` from a dedicated repository.** The RelayAPI repository keeps server discovery, session JSON, adapters, and tests in one change.

**Build the launcher in TypeScript.** Go matches the existing toolchain and produces a single executable.

**Use browser callback authorization for this slice.** Milestone 1 enrolls with `--api-key-stdin` so existing recoverable keys work immediately. PKCE device authorization stays queued for the next slice.

## Consequences

Users can `go build ./cmd/rai`, run `rai login --server <url> --api-key-stdin`, then `rai codex` / `rai opencode` against a live RelayAPI deployment. CI builds both `./cmd/relayapi` and `./cmd/rai`. Follow-on work: PKCE device login and approval UI, release assets and `rai update`, Claude Code and other adapters, server-delivered launch recommendations.
