# Agent Note: Integrate through CPA SDK seams and shrink the maintained fork

Status: implemented

## Problem

The shipped startup is `App.New -> startEmbeddedCPA -> embeddedCPAAdapter`, despite older native-runtime documentation and retained native implementation files. The adapter sends inference to the embedded CPA server. The user wants CPA to own provider execution and usage interpretation so Relay can follow CPA maintenance without repeatedly copying its changes. This change moves supported interfaces to the public SDK and consumes scoped CPA usage records. It preserves the shipped transport topology and credential lifecycle.

The pinned fork `dad77ec33c28dfc20d90654c798e175f19698944` is exactly two commits ahead of upstream v8.0.4 (`d33f63f8e3d98428440ebca5a5b6a981a61ff71e`): shared credential refresh (`b611ef4d9402e6af9f26be2ad3945ae4a7081b1d`) and credential snapshot isolation. The [upstream comparison](https://github.com/router-for-me/CLIProxyAPI/compare/d33f63f8e3d98428440ebca5a5b6a981a61ff71e...4627488:relay/credential-refresh-v8.0.4) changes three production files and two test files. The remaining integration code is Relay's own [bridge module](../../../../third_party/cpaexecutor/runtime.go), rather than additional edits to the CPA repository.

The bridge manually builds the server, registers baseline executors, compiles credential models, and subscribes to internal model-update functions. It imports internal API, config, registry, executor, translator and cache packages. CPA's SDK configuration and server-option packages explicitly expose embedding interfaces to avoid internal imports. Its Builder/Service owns executor binding, auth watching, model registration, refresh and shutdown. Maintaining those lifecycles again makes upgrades harder even if the fork itself is small.

The [OpenAI compatibility executor](../../../../third_party/cpaexecutor/openai_compat.go) delegates ordinary Chat requests but implements Responses HTTP/SSE, thinking, payload shaping and usage reporting locally. Upstream's regular OpenAI compatibility executor still targets Chat Completions except for its compact path; an existing RequestInterceptor can alter headers/body but cannot select a different upstream protocol or URL. This is a real capability gap, not an import cleanup. The local request pipeline now follows the update-intent handling used by upstream's paired request translation.

## Decision

Config, server options, basic model registration and translator registration now use public SDK contracts. The compatible Responses extension uses CPA paired request translation and update intent, including plugin removal of configuration updates. Internal seams and their missing public equivalents are documented in the [bridge boundary](../../../../third_party/cpaexecutor/README.md).

CPA's public usage plugin supplies canonical text tokens and actual service tier. Context-bound per-execution scopes isolate concurrent requests, failed attempts and auxiliary model records. HTTP selects its final successful execution; WebSocket selects an exact response ID and retains existing per-turn database idempotency before terminal forwarding. Canonical input includes cache writes, so Relay subtracts writes from its prompt bucket before charging writes separately. Canonical output already includes reasoning. Zero-token complete records are valid; missing or inconsistent records remain incomplete and settle the existing reservation conservatively. The async queue waits at most 750ms and is not a durable event bus. Existing reservation settlement and request/turn logs remain the durable ledger; no extra datastore or event table was added.

Image endpoints and observed image modality buckets retain the existing parser because the public SDK has no image buckets. Response parsing also remains for envelope metadata and diagnostics, but cannot override CPA text accounting. Full parser deletion is deferred until the modality interface exists. Both fork patches remain; Service migration is deferred because private lifecycle/rebinding would overwrite observations and undermine DB credential ownership. No upstream messages or PRs were submitted.

Fast priority service defaults to 2x normal token rates in Relay pricing. An explicit returned tier takes precedence over the request tier; missing returned tiers fall back to the request. Matching administrator tier rules replace the default instead of stacking another factor of two; other multipliers compose normally. Existing log tier fields supply the Fast badge and requested/actual tier detail without a new schema. Tests cover downgrade, explicit overrides, aliases, exact doubled modality/cache/reasoning costs and responsive badge visibility.

Validation: root `go test ./...` and `go vet ./...` passed; bridge `go test ./...` passed. Database integration tests are not verified because TEST_DATABASE_URL is absent. Regression coverage includes configuration-update removal, canonical cache/reasoning mapping, concurrent usage isolation, retries, duplicate publications, delayed callbacks, exact WebSocket turns and zero/missing/inconsistent records.

## Remaining direction

Use CPA to interpret provider protocols, execute requests, register executable models and report usage. Keep tenant authorization, subscription grants, reservations, prices, durable accounting and redacted audit views in Relay. CPA's model catalog is execution capability; Relay's allowlists remain authorization policy. Never bypass Relay admission or permit CPA retry/routing to escape the selected parent credential.

### Prefer existing public interfaces

Replace applicable internal config types with `sdk/config` aliases and internal server options with `sdk/api` wrappers. Basic registry reads, client registration and registration hooks can use `sdk/cliproxy.GlobalModelRegistry` and `SetGlobalModelRegistryHook`. Translator registration and registered translation dispatch can use `sdk/translator` and its builtin registration package. These substitutions do not require a CPA fork. Server construction, static plan catalogs and catalog-updater callbacks still have gaps; merely changing imports does not remove those responsibilities.

Consume `sdk/cliproxy/usage.Plugin` records instead of reparsing converted downstream responses for billing. Request and execution identities must be explicitly associated, including multiple WebSocket turns and retries. Usage records supply token breakdown, response model, credential and requested/actual service tiers; they do not calculate Relay prices. The default usage dispatcher is an asynchronous in-memory queue, not a durable ledger. Persist received records and settle idempotently; define handling for absent, late and duplicate events before deleting response-based accounting. Do not claim the asynchronous callback alone guarantees delivery across crashes or synchronous per-turn quota enforcement.

### Let the official Service own its lifecycle

Evaluate CPA Builder/Service with the existing database-backed auth persistence adapter, core manager and server options. Let the official service own built-in executor binding and model registration; observe its registry to synchronize Relay grants. Verify the credential update/watch path, stable credential IDs, exclusion/alias semantics and completion ordering before replacing the bridge's manual registration. SDK client-provider Load results are primarily statistics and are not proof of automatic database-auth registration.

This is a lifecycle migration, not a one-line constructor swap. The current SDK starts an HTTP listener and does not expose a complete ServeHTTP-only lifecycle. The shipped adapter already uses a loopback listener; this proposal neither adds another hop nor changes transport topology. If removing that hop is separately required, request an upstream lifecycle/handler embedding API rather than copying the service again.

CPA can rebind executors when auth or config changes. In particular, its Codex registration recognizes the concrete CodexAutoExecutor and can replace Relay's telemetry wrapper. Custom executors and observations must enter supported plugin/transport/lifecycle seams or have a verified rebind mechanism. Do not assume a single RegisterExecutor call remains installed after updates. Usage latency/TTFT are not replacements for all existing provider DNS/TCP/TLS and attempt traces; preserve required detail through an appropriate observation seam or document any deliberate reduction.

### Resolve the two actual fork patches separately

The shared RefreshCredential patch adds proactive provider-policy refresh, failure backoff, reuse of concurrent refreshes and the latest runtime snapshot for external quota probes. Upstream GetByID and ForceRefreshAuth are not equivalent: GetByID only reads state; ForceRefreshAuth bypasses the ordinary freshness decision and does not coalesce all callers using an observed failed token. Prefer proposing a general EnsureFresh/refresh-if-stale API upstream. A zero-feature-patch alternative is to use GetByID, rely on CPA background refresh, and force once after quota 401 with Relay-side coalescing/backoff; it gives up the current synchronous pre-probe freshness guarantee. Do not silently make that behavior change or recreate all CPA provider refresh policy in Relay. The current contract is documented in [credential-refresh.md](../../../../docs/credential-refresh.md).

The credential snapshot patch fixes shared mutable state after the manager lock is released. It belongs upstream. Relay-side locking does not protect CPA's internal concurrent result writers, and returning to the unfixed release is not an equivalent integration strategy. As of this audit, upstream main still contains the affected post-lock snapshot pattern. Retain the small tested fix until an upstream equivalent is available; prepare an upstream contribution rather than inventing a second credential owner. No upstream message or PR was submitted by this audit.

### Remove the largest provider protocol copy when supported upstream

Propose configurable Chat/Responses upstream selection for CPA's OpenAI compatibility executor so official request translation and usage reporting serve both modes. Keep Bailian endpoint-specific cache headers as small configuration/interceptor/transport adaptation. Once that functionality exists upstream, delete the matching Relay executor pipeline. A supported custom provider plugin is an interim isolation option, but moving the same code to a plugin does not eliminate protocol maintenance.

The OAuth capture token store already adapts storage while leaving provider login/refresh to CPA. Preserve that boundary. Do not reduce internal imports by reimplementing OAuth flows in Relay.

## Alternatives considered

Copy CPA parsing helpers into Relay: rejected because each new provider field and protocol fix would still require manual synchronization. Thin direct wrappers can be transitional, but structured usage records from CPA execution avoid another parser.

Replace the shared refresh call with unconditional ForceRefreshAuth: rejected as an equivalent change because it loses freshness policy, backoff and some coalescing. Read-current/401-recovery is a possible documented behavior tradeoff, not a drop-in substitute.

Drop both fork patches immediately: rejected while the snapshot race remains unfixed and the quota contract requires synchronous policy-aware refresh. Zero local patches is a maintenance objective, not evidence that an upstream release preserves current behavior.

Register custom executor wrappers once after Service startup: rejected because auth/config updates can rebind executors. Use the official extension lifecycle and test updates.

## Acceptance criteria

- Inventory every remaining internal import and explain the missing public seam; avoid suggesting that public option aliases alone remove internal server construction.
- CPA execution events are associated with Relay reservation, credential, attempt and WebSocket turn; durable idempotent accounting handles duplicates, missing usage and failed/retried executions according to an explicit charging policy.
- Credential rotation persists through one owner; quota probes use current runtime credentials and cannot introduce concurrent provider refresh implementations.
- Auth/model/config refresh preserves strict parent pinning, aliases, exclusions and tenant model authorization. Custom extensions survive official executor rebinding.
- Responses, streaming cache/modality usage, terminal failures, prewarm and multi-turn WebSocket behavior have integration coverage before the local parser/executor paths are removed.
- Replace the two CPA module replacements only after refresh behavior is intentionally reconciled and the upstream snapshot defect has an equivalent fix. Keep both module pins aligned until then.
- Update stale native-only docs and notes when shipping the new boundary; this audit records current startup evidence without rewriting historical decisions.

## Risks

SDK and plugin contracts can evolve; centralize their adaptation in one module and verify upgrades with integration tests. Model-registry hooks and usage dispatch are process-scoped, so ownership and shutdown must be explicit. The async usage queue and upstream attempts have different semantics from Relay's durable reservation/turn boundaries; a naive event subscriber could miss charges, charge retries twice or allow later turns before quota enforcement. Changes to refresh guarantees, fine-grained telemetry or compatible-provider protocol support must be stated rather than hidden as cleanup.
