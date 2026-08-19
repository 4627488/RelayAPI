# RelayAPI architecture

RelayAPI is a Codex-first, multi-tenant policy and accounting gateway. It owns
the provider runtime for Codex, Kimi, xAI/Grok and OpenAI-compatible services
such as Aliyun Bailian. There is no external or embedded third-party proxy
runtime.

## Request boundary

The public layer authenticates the tenant key, resolves aliases, checks model
policy, reserves balance/quota and strips untrusted `X-Relay-*` headers. The
native runtime then selects the pinned encrypted credential, translates the
wire protocol when needed, lowers unsupported tool declarations, performs
OAuth refresh and sends the provider request. Terminal usage is persisted and
settled before the response is considered complete.

Supported public protocols are Responses, Chat Completions, the OpenAI model
catalog, Codex-compatible paths and Responses WebSocket. Anthropic Messages and
Gemini-native `/v1beta/*` remain intentionally unsupported.

## Codex interoperability

Codex model catalogs advertise the full agent surface by default: freeform
`apply_patch`, web search, parallel tools, image input, reasoning summaries,
skills/plugins/apps instructions, WebSocket preference and multi-agent v2.
Administrators may select the diagnostic `verified` policy, but optimistic is
the product default.

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
- Repeated transport failures open a circuit breaker with one recovery probe.
- Provider errors and Relay errors are returned as written and recorded on the
  request log. There is no transparent retry of 408/429/502/503/504.
- OAuth tokens refresh proactively near expiry. A 401 still refreshes the
  stored token for later requests but is returned as-is.
- HTTP, HTTPS, SOCKS5 and SOCKS5H proxies are implemented in Relay and apply to
  inference, WebSocket, discovery, OAuth, quota and system requests.
- Provider credentials remain encrypted in PostgreSQL. The native runtime
  is called in-process; there is no loopback HTTP hop or process-local API key.
- PostgreSQL row locks make reservation and settlement idempotent and atomic.

## Models and pricing

OpenAI-compatible accounts discover `GET {base_url}/models`; native providers
use controlled defaults and credential-scoped discovery where supported.
Tenant and key allowlists are applied after runtime discovery. Prices remain
local accounting metadata rather than a model allowlist. Each request snapshots
its resolved modality-aware integer price and catalog version.
