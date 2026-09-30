# RelayAPI architecture

RelayAPI is a Codex-first, multi-tenant policy and accounting gateway. It owns
tenant policy, prices and durable accounting, and embeds CPA for provider
execution for Codex, Kimi, xAI/Grok and OpenAI-compatible services such as
Aliyun Bailian. The SDK adaptation lives in `third_party/cpaexecutor`.

## Request boundary

The public layer authenticates the tenant key, resolves aliases, checks model
policy, reserves balance/quota and strips untrusted `X-Relay-*` headers. The
embedded CPA runtime then selects the pinned encrypted credential, translates the
wire protocol when needed, lowers unsupported tool declarations, performs
OAuth refresh and sends the provider request. HTTP settlement runs after the
response boundary; WebSocket terminal turns are persisted before forwarding so
the next turn remains subject to quota enforcement.

Text billing consumes CPA's public structured usage plugin records, correlated
to an execution scope and, for WebSocket, a response ID. Failed attempts and
auxiliary model records are excluded. Delivery waits are bounded to 750ms;
missing or incomplete usage conservatively settles the existing reservation
with `pricing_complete=false`, preserving the accrued estimate in the log.
Explicit CPA `Generate=false` records are complete zero-cost prewarm outcomes.
CPA local synthetic prewarm has no executor callback: Relay recognizes it only
with explicit prewarm intent, the CPA `resp_prewarm_` identity and complete zero
usage. HTTP and WebSocket share the same settlement assessment.
Request-log lists show only settled positive charges (balance or child quota);
prewarm and connection events remain trace-only records addressable by ID.
Generation statistics and retention rollups exclude those trace records.
Requested Priority and upstream-confirmed Priority are displayed separately. The plugin queue is in memory, while PostgreSQL
remains the accounting ledger. CPA does not expose image modality buckets in
the public usage SDK, so image accounting retains the existing response parser.
Relay still owns pricing rules, tenant balances and subscription quotas.

Supported public protocols are Responses, Chat Completions, the OpenAI Images
API (`/v1/images/generations` and `/v1/images/edits`), the OpenAI model
catalog, Codex-compatible paths and Responses WebSocket. Anthropic Messages and
Gemini-native `/v1beta/*` remain intentionally unsupported.

Images follow the current CPA split: Codex `gpt-image-1.5` and `gpt-image-2`
proxy the ChatGPT backend `/images/*` endpoints instead of wrapping Responses;
xAI `grok-imagine-*` maps OpenAI `size`/`quality` onto `aspect_ratio` and
`resolution`; OpenAI-compatible credentials pass Images through unchanged.
Image-only slugs stay hidden in the Codex picker and are still callable on
the Images API. The Responses wrap that older CPA builds used for
`gpt-image-2` is not implemented.

## Codex interoperability

Codex model catalogs advertise a complete `ModelInfo` per published slug so
the client does not fall back to `model_info_from_slug`. Relay's tenant, key,
and subscription allowlists decide visibility: allowed models are `list`,
denied official slugs stay as `hide` tombstones (dropping them would let
Codex's bundled copy reappear). Each row includes reasoning levels, both
context windows, `shell_type`, `supported_in_api`, `priority`,
`base_instructions`, and the full agent surface: freeform `apply_patch`, web
search, parallel tools, image input, reasoning summaries, skills/plugins/apps
instructions, WebSocket preference and multi-agent v2. Image-only slugs such
as `gpt-image-*` stay hidden in the Codex picker. Optimistic capability
advertising is the product default; adapters lower unsupported wire details.

Context windows, input modalities, and advertised reasoning levels for
non-OpenAI slugs are overlaid from [models.dev](https://models.dev/api.json),
the same catalog Relay already fetches for prices. The snapshot loads from
stored `RawJSON` on boot and refreshes a few seconds later, or immediately
after an admin catalog sync. First-party rows win (`openai`, `xai`,
`deepseek`, `moonshotai`, then `moonshotai-cn`); aggregator copies of the
same slug are ignored. Official OpenAI slugs keep Relay's Codex template so
the bundled picker contract stays stable. Moonshot and DeepSeek overlays
turn off `prefer_websockets` (Relay's WebSocket path is Responses-native and
those providers are Chat-only) plus verbosity and multi-agent flags those
APIs do not have. `apply_patch` stays freeform; adapters still lower it for
Chat. models.dev is not a permission source, and Relay does not fetch CPA's
`models.json` or embed the official Codex catalog. Administrators can
correct or fill gaps on the 模型设置 page; those rows win over
models.dev. `kimi-k3-256k` is seeded that way: it is the Kimi Coding
Plan 256k window of the same always-on K3 family (`low`/`high`/`max`),
which models.dev does not publish.

Model settings override individual fields, preserving unspecified catalog facts.
Explicit capability values survive ModelInfo completion. Provider-specific
constraints remain separate from a transport preference: disabling WebSockets
alone does not disable verbosity or multi-agent metadata. Catalog revisions
include a content hash of facts and overrides, so deleting an override also
invalidates client caches. Failed database reads retain the published snapshot.

The embedded CPA runtime starts CPA's provider-model updater after its routes
are ready. A successful remote catalog change for Codex or xAI rebuilds the
credential routes, persists newly added models, and updates parent subscription
model ranges. CPA's embedded definitions remain available when the remote
catalog cannot be fetched. Tenant and key restrictions still apply to the
expanded list.

Quota storage supports all active child subscriptions usable by the authenticated
key. Four batch queries project allocations against current parent generations,
including unused grants, without creating reservations. Duration-bearing kinds
retain their real period and reset time; unrelated subscriptions are never summed.

The current Codex adapter selects only the admitted child and emits a single
fixed `codex` bucket. It selects the two shortest valid periods deterministically;
additional windows stay available internally. HTTP uses X-Codex header fields;
WebSocket replaces the whole bucket at startup and after durable terminal usage.
An absent second window is null, so switching subscriptions clears the previous
slot. Unmetered, unavailable or failed reads produce an empty snapshot, avoiding
stale allowances from another subscription. Reads have a 250ms budget; upstream
quota events are suppressed.

This compatibility policy addresses Codex 0.156.1 inference coalescing multiple
buckets into one final notification. Native simultaneous multi-subscription
output remains disabled until the client supports it. Real app-server tests
cover two windows, a switch to one window, and empty quota over both transports.
WebSocket discards display names; this does not change OpenAI account allowances.

Provider adapters preserve that client contract. For example, xAI and generic
Chat Completions backends receive a JSON-schema string-input function when
Codex sends a freeform custom tool. Relay restores the provider's function call
to the original `custom_tool_call`, including call IDs and namespaces. Kimi and
other Chat-only endpoints are translated bidirectionally between Responses and
Chat Completions: parallel tool calls stay on one assistant message, reasoning
summary maps to `reasoning_content`, structured `text.format` maps to
`response_format`, missing `call_id`s are synthesized, and streams still emit
`response.completed` when upstream only sends `[DONE]`. Custom tools lowered
for Chat are restored on the way back.

WebSocket sessions support multiple turns. A completed turn may release its
upstream connection while retaining the downstream session; the next complete
turn reconnects with the same credential. `generate:false` prewarm is answered
locally without consuming provider capacity.

Bailian credentials are first-class: Chat Completions is translated to the
DashScope Responses path so prefix cache can attach, and requests that share
`prompt_cache_key`, `previous_response_id`, or `user` stay on the same
credential for an hour.

Request logs keep a version-3 latency trace. Relay records admission and
in-process runtime timing; the native runtime overlays routing, each provider
attempt, and provider DNS/TCP/TLS spans on parallel tracks so they are not
added twice into the critical path.

## Reliability and security

- Admission bounds concurrency, queue depth and aggregate buffered request
  bytes before the body is read.
- Process-wide circuit breaking is off by default. Consecutive credential
  failures can still isolate one account without taking the whole process down.
- Provider errors and Relay errors are returned as written and recorded on the
  request log. There is no transparent retry of 408/429/502/503/504.
- OAuth tokens refresh proactively near expiry. A 401 still refreshes the
  stored token for later requests but is returned as-is.
- HTTP, HTTPS, SOCKS5 and SOCKS5H proxies are implemented in Relay and apply to
  inference, WebSocket, discovery, OAuth, quota and system requests.
- Provider credentials remain encrypted in PostgreSQL. CPA runs in this process
  behind the existing private loopback listener, with a process-local API key.
  Public traffic must pass Relay admission before it reaches that listener.
- PostgreSQL row locks make reservation and settlement idempotent and atomic.

## Models and pricing

Fast (`service_tier=priority`) defaults to twice the normal token rates,
including cache and reasoning rates. The returned service tier takes precedence
over the requested tier: a `default` response to a `priority` request uses normal
rates; when the upstream omits the tier, the requested tier is used. A matching
administrator `service_tier` or `response_service_tier` price rule replaces this
default, so configuring a 2x rule does not result in a 4x charge. Other model and
account multipliers still compose normally. Request logs show a Fast badge and
the billing detail shows requested/actual tiers and the total price multiplier.

OpenAI-compatible accounts discover `GET {base_url}/models`; native providers
use controlled defaults and credential-scoped discovery where supported.
Tenant and key allowlists are applied after runtime discovery. Prices remain
local accounting metadata rather than a model allowlist. Each request snapshots
its resolved modality-aware integer price and catalog version.

Codex `codex-auto-review` requests can use the originating session's model.
Relay first accepts an explicit parent model in `metadata.parent_model`,
`metadata.session_model`, `metadata.original_model`, `metadata.model`, or
`session.model`. Otherwise it matches a recent main request from the same API
key using Codex's `thread-id` and auto-review `x-codex-parent-thread-id`, or
the shared `session-id`. In a Codex 0.158.0 probe, the reviewer had its own
`thread-id` and `prompt_cache_key`; neither value alone identified the parent.
Other clients may use a shared prompt cache key. The association is process-local
and expires after one hour. Relay only rewrites to a model
that the key may use and the runtime currently publishes; unknown or ambiguous
review requests keep the original model. An API-key alias for
`codex-auto-review` takes precedence over this automatic mapping.
