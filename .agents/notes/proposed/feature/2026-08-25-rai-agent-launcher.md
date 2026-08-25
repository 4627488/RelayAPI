# Agent Note: Ship the rai agent launcher

Status: proposed

## Problem

RelayAPI already gives Codex and OpenCode a complete gateway contract and a five-minute connection guide that writes durable client configuration, while each coding-agent CLI also carries its own provider selection, authentication, model discovery, feature flags, and configuration precedence. Users who work across several agents need one Relay-aware entry point that signs in once, selects a permitted model, prepares the matching client contract for that launch, and preserves the agent's familiar command line.

OpenRouter's Ori validates this product shape: `ori login` uses OAuth PKCE, `ori codex` and sibling commands execute the real client found on `PATH`, `--model` selects a model for the run, and model-aware launch profiles tune client settings. The public [`OpenRouterLabs/ori-releases`](https://github.com/OpenRouterLabs/ori-releases) repository is an Apache-2.0 distribution mirror containing binaries, installers, checksums, `LICENSE`, and `NOTICE`; its README states that the development source lives in a separate repository. The Apache grant covers the released binary and its source tree, while the currently visible implementation surface consists of the generated Bash installer and public behavior. Relay can adapt the installer structure with attribution and implement the launcher core in Go inside this repository.

## Proposal

Create a standalone `rai` executable from `cmd/rai`, with reusable code under `internal/rai`. The first release supports Codex and OpenCode, matching the clients already represented by `internal/app/agent_setup.go`; the adapter contract then carries Claude Code, Grok Build, Hermes, Pi, and future clients as additional implementations.

### Command contract

The primary commands are `rai login --server https://relay.example`, `rai logout [--profile name]`, `rai status`, `rai models`, `rai use <model>`, `rai codex [--model model] -- <codex args>`, `rai opencode [--model model] -- <opencode args>`, `rai doctor`, `rai update`, and `rai completion <shell>`. A named profile represents one RelayAPI deployment and credential; `--profile`, `RAI_PROFILE`, and the active profile select it in that precedence order. Arguments following `--` pass through byte-for-byte, signals flow to the child process, terminal stdio remains attached, and `rai` exits with the child's exit code.

`rai login` first reads `/.well-known/rai.json` from the selected deployment. This document publishes the deployment name, API base, authorization endpoints, supported launcher contract version, available adapters, and minimum `rai` version. The CLI creates a PKCE S256 verifier/challenge pair, requests a short-lived device authorization, opens the returned verification URL, and prints the URL plus user code for terminal and headless use.

The browser approval page uses the existing RelayAPI session. It shows the device label, requested adapter set, API-key name, model allowlist, per-minute limit, daily token limit, and credential expiry. Approval creates a dedicated `relay_*` API key through the existing key lifecycle and binds a default model chosen from the effective tenant, subscription, key, and alias catalog. The CLI exchanges its authorization ID and verifier exactly once and receives the endpoint, key, allowed models, default model, and server contract version.

`rai` stores profile metadata in the platform configuration directory and stores the API key in the native credential store. A file-backed credential provider with owner-only permissions supports headless Linux environments. Child processes receive the credential through the client's supported authentication mechanism, and diagnostic output redacts credentials, authorization codes, verifier material, and generated configuration secrets.

### Server contract

Add `internal/app/rai_authorization.go` and a `rai_authorizations` table containing a hashed authorization identifier, PKCE challenge, user code hash, device metadata, requested adapters, approval state, tenant ID, generated API-key ID, encrypted exchange payload, expiry, consumed timestamp, and audit timestamps. Creation, approval, expiry, and exchange use database transactions; exchange atomically marks the grant consumed before returning the decrypted payload.

Expose `POST /api/rai/authorizations` for authorization creation, `GET /rai/authorize/{id}` for the browser approval surface, `POST /api/rai/authorizations/{id}/approve` behind the tenant session, `POST /api/rai/token` for PKCE exchange, and `GET /api/rai/session` behind Relay API-key authentication. The session response returns the effective model catalog, aliases, model metadata needed by adapters, API-key limits, and launcher recommendations. All authorization and token responses use `Cache-Control: no-store`; creation, code verification, and token exchange receive dedicated rate limits.

The generated API key appears in the existing key management page with a `rai · <device>` name and launcher metadata. Revocation takes effect on the next model refresh or request. Re-login creates a fresh device credential, while `rai logout --revoke` revokes the matching server key and clears the local credential.

### Launcher core

Define an adapter interface with `Name`, `Probe`, `ResolveModel`, `Prepare`, and `Exec` responsibilities. `Probe` resolves the executable and parses its version; `ResolveModel` validates the requested model against `/api/rai/session`; `Prepare` returns executable, arguments, environment additions, and ephemeral files; `Exec` owns stdio, signal forwarding, and exit propagation. Every adapter has a version range and golden launch-contract fixtures so client releases can update independently.

The Codex adapter selects the Relay provider, Responses wire API, WebSocket and search capabilities, model, reasoning effort, and a `rai credential print` auth command through supported user-level/session configuration overrides. It preserves the user's `CODEX_HOME`, sessions, MCP configuration, approval policy, sandbox policy, and ordinary command arguments. The adapter refreshes the authenticated model catalog before launch and maps Relay `ModelInfo` into Codex-visible choices.

The OpenCode adapter supplies a runtime provider block through `OPENCODE_CONFIG_CONTENT`, selects `@ai-sdk/openai` for Responses or `@ai-sdk/openai-compatible` for Chat Completions, fills the effective model list, and passes the selected credential through an environment reference. Existing user, project, agent, command, plugin, permission, and MCP settings continue through OpenCode's configuration merge.

The launcher configuration is versioned as `rai.dev/v1`. Profiles contain server URL, server ID, display name, credential reference, active adapter defaults, default model, reasoning effort, and last successful contract refresh. Writes use an owner-only temporary file followed by atomic rename. Concurrent launches share read-only profile state and serialize refresh writes with a file lock.

### Packaging and updates

Build `rai` as a Go executable from the RelayAPI module and publish Linux, macOS, and Windows assets for AMD64 and ARM64. Each release contains immutable versioned binaries, `SHA256SUMS`, an SBOM, provenance, `LICENSE`, and installers for Bash and PowerShell. Release binaries use the same version and commit vocabulary as RelayAPI while retaining an independent launcher compatibility version.

Adapt Ori's Apache-2.0 installer mechanics for platform and libc detection, stable and preview channels, HTTPS-only downloads, retry handling, checksum verification, atomic installation, and `RAI_INSTALL_DIR`. Preserve the upstream copyright and license notice for adapted installer portions and record the adaptation in RelayAPI's `NOTICE`. Add Windows asset selection and PowerShell parity as Relay-specific work.

`rai update` reads a signed release manifest, chooses the matching platform asset, verifies its checksum and provenance, replaces the executable atomically, and retains the previous binary for rollback. `rai doctor` reports executable discovery, client versions, profile health, credential-store access, server reachability, contract compatibility, model visibility, and a harmless authenticated model-list check.

### Delivery sequence

Milestone 1 adds the `rai` command framework, profile and credential providers, process execution, Codex and OpenCode adapters, fixture-based adapter tests, local `--api-key-stdin` enrollment, `models`, `status`, and `doctor`. This produces a useful launcher against current RelayAPI deployments.

Milestone 2 adds device authorization with PKCE, the browser approval page, dedicated launcher API keys, authenticated session bootstrap, revocation, expiry, and audit events. The existing connection guide gains an “Install rai” path that emits the deployment URL and opens the authorization flow.

Milestone 3 adds cross-platform release assets, installers, checksums, provenance, self-update, shell completion, stable/preview channels, and CI installation verification on Linux, macOS, and Windows.

Milestone 4 expands the adapter catalog and introduces server-delivered model-aware launch recommendations. Each adapter release includes a real-client compatibility matrix and records the client version, selected recommendation set, and resulting request client identity in Relay request logs.

### Testing strategy

Unit tests cover command parsing, profile precedence, atomic writes, credential redaction, PKCE verification, expiry, single-use exchange, model selection, generated Codex TOML values, generated OpenCode JSON, argument preservation, environment merging, signal forwarding, and child exit propagation. Fake client executables capture argv, environment, cwd, and stdin/stdout behavior as golden fixtures.

Store integration tests cover concurrent approval and exchange, API-key creation, model and alias scope, limits, revocation, cleanup, and tenant isolation. HTTP tests cover discovery, authorization, approval, token exchange, session bootstrap, cache headers, rate limits, and error envelopes.

End-to-end CI installs each published asset in a clean environment, enrolls against an ephemeral RelayAPI instance, launches stub Codex and OpenCode binaries, and verifies an authenticated `/v1/models` request. A version matrix also runs supported real Codex and OpenCode releases with a harmless prompt against a deterministic test upstream. Windows tests exercise PowerShell installation, credential storage, path quoting, Ctrl+C forwarding, and Unicode paths.

## Alternatives considered

**Continue growing the generated connection scripts.** This remains the shortest route for durable Codex and OpenCode configuration. `rai` is selected for sign-in once, per-launch model choice, client-version-aware settings, device credential lifecycle, diagnostics, and expansion across agent CLIs; the connection scripts remain a convenient setup option.

**Publish `rai` from a dedicated repository.** A separate repository gives the launcher an independent issue tracker and release cadence. The RelayAPI repository is selected initially because server endpoints, model contracts, installation templates, integration tests, and release compatibility evolve together; the Go package boundary keeps a future repository split straightforward.

**Build the launcher in TypeScript.** TypeScript aligns with several coding-agent ecosystems and offers mature configuration libraries. Go is selected for a single executable, shared Relay types and validation, fast startup, straightforward cross-compilation, and the repository's existing toolchain.

**Use browser callback authorization.** A localhost PKCE callback completes immediately after browser approval. PKCE-backed device authorization is selected because the same flow serves desktop terminals, SSH sessions, containers, and remote hosts while keeping browser approval on the Relay deployment.

## Acceptance criteria

- `rai login --server <url>` completes browser or headless authorization and creates a revocable device-specific Relay API key with user-selected model and usage limits.
- `rai codex --model <allowed-model> -- <args>` and `rai opencode --model <allowed-model> -- <args>` launch the real client on `PATH`, preserve arguments and terminal behavior, and send authenticated inference through the selected RelayAPI deployment.
- `rai models`, `rai status`, and `rai doctor` reflect effective tenant, subscription, key, alias, and server contract state.
- Profiles and credentials support Linux, macOS, and Windows with owner-scoped storage, atomic updates, redacted diagnostics, and concurrent launches.
- Authorization grants expire, exchange once, enforce PKCE, create auditable API keys, honor revocation, and pass tenant-isolation integration tests.
- Release automation publishes immutable cross-platform assets, checksums, provenance, installers, and a verified self-update path.
- Codex and OpenCode compatibility fixtures plus the real-client CI matrix pass for every supported launcher release.
- Adapted Apache-2.0 installer portions carry the required `LICENSE`, `NOTICE`, copyright, and modification attribution.

## Risks

Coding-agent configuration contracts evolve quickly. Version-gated adapters, real-client CI, server contract negotiation, and actionable `rai doctor` output turn each client change into a bounded adapter update.

Device authorization creates a credential-minting surface. PKCE S256, short grant expiry, hashed codes, atomic one-time exchange, tenant-confirmed scopes, dedicated rate limits, encrypted exchange payloads, visible device keys, and audit events provide layered controls.

Cross-platform process and credential behavior varies. Small platform interfaces, native CI runners, fake-child contract tests, Unicode and quoting fixtures, and platform credential providers keep the shared command semantics consistent.

Self-update carries supply-chain sensitivity. Immutable release tags, HTTPS, checksums, signed provenance, SBOMs, atomic replacement, and retained rollback binaries establish verifiable releases.

Model metadata and client feature flags can drift independently. The authenticated session contract carries model capabilities and recommendation versions, while the launcher records the applied adapter and recommendation versions for diagnosis.
