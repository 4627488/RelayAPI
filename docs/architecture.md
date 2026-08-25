# RelayAPI architecture

RelayAPI is a Codex-first, multi-tenant policy and accounting gateway. It owns
tenant auth, admission, and settlement. Provider inference for Codex, Kimi,
xAI/Grok and OpenAI-compatible services such as Aliyun Bailian runs through
official embedded CPA (`relaybridge`), invoked in-process.

## Request boundary

The public layer authenticates the tenant key, resolves aliases, checks model
policy, reserves balance/quota and strips untrusted `X-Relay-*` headers. The
native runtime then selects the pinned encrypted credential, translates the
wire protocol when needed, lowers unsupported tool declarations, performs
OAuth refresh and sends the provider request. Terminal usage is persisted and
settled before the response is considered complete.

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
- Provider credentials remain encrypted in PostgreSQL. Embedded CPA is called
  in-process through `Handler().ServeHTTP` and an in-memory WebSocket pipe;
  there is no `127.0.0.1` listener. CPA's mux still requires a process-local
  API key on those in-process calls.
- PostgreSQL row locks make reservation and settlement idempotent and atomic.

## Models and pricing

OpenAI-compatible accounts discover `GET {base_url}/models`; native providers
use controlled defaults and credential-scoped discovery where supported.
Tenant and key allowlists are applied after runtime discovery. Prices remain
local accounting metadata rather than a model allowlist. Each request snapshots
its resolved modality-aware integer price and catalog version.
