# RelayAPI rewrite architecture

## Goal

RelayAPI is a multi-tenant policy and accounting gateway in front of
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). CLIProxyAPI owns
provider credentials, protocol translation, model aliases, retries, and
provider selection. RelayAPI must not contain a provider/model registry.

The backend also owns the product-facing user lifecycle: first-user setup,
single-use invitations, invited registration, user sessions, user-created API
keys, administrator capabilities, and administrator/user usage reports. An
administrator is a normal user with an additional permission flag, not a
separate account or access-key session. It intentionally contains no frontend
assets.

## Request flow

```text
OpenAI / Anthropic / Gemini client
              |
              v
 RelayAPI: tenant key -> policy -> optional balance reservation
              |
              v
 CLIProxyAPI: protocol adapter -> model/alias router -> provider credential
              |
              v
 RelayAPI: usage parser -> settlement -> audit log
```

RelayAPI forwards the public inference surfaces without translating payloads:

- OpenAI-compatible `/v1/*`, including chat, responses, images and models
- Anthropic Messages API on `/v1/messages`
- Gemini native API on `/v1beta/*`
- compatibility paths used by Codex and other CLI clients (`/backend-api/*`,
  `/openai/v1/*`)

The caller's Relay key is replaced with the private CLIProxyAPI API key. Query
strings, request bodies, status codes, SSE events, and end-to-end headers are
preserved. Hop-by-hop headers are removed. WebSocket upgrades are tunneled.

## Model and pricing policy

`GET /v1/models` is dynamically served by CLIProxyAPI, so a newly configured
model is immediately available. Empty tenant/key allowlists mean all models;
allowlists support exact names, `*`, and glob patterns.

Prices are local accounting metadata, not a model allowlist:

- `UNPRICED_MODEL_POLICY=allow` (default): forward an unknown model, record its
  usage, mark pricing incomplete, and charge zero.
- `UNPRICED_MODEL_POLICY=deny`: reject billable calls whose model has no local
  price.

This separation is what lets the gateway support every model exposed by
CLIProxyAPI without silently inventing prices.

## Reliability and security

- PostgreSQL row locks make balance reservation/settlement atomic.
- A request is settled only after usage is found; upstream errors are refunded.
- Responses without usage are refunded and remain visibly marked as
  pricing-incomplete, so missing provider usage cannot lock tenant funds.
- Request bodies and captured response tails are bounded.
- Routine management endpoints expose typed, validated credential/OAuth and
  runtime-policy operations using CPA's redacted responses. Full configuration
  access is explicitly confined to authenticated Relay administrators.
- Administrators additionally get a no-store, session-protected transparent
  Management API bridge. This is the compatibility escape hatch for the full
  CPA configuration and future providers/plugins; it is never exposed to
  tenant sessions or public API keys.
- Health checks test both PostgreSQL and authenticated CLIProxyAPI model
  discovery.

## Deployment boundary

CLIProxyAPI should only be reachable on the private Docker network. Its public
API key and management key are service credentials; tenant clients receive only
`relay_*` keys. Provider credentials stay entirely inside CLIProxyAPI.

## CPA v7 plugin boundary

`cliproxyapi-plugin/` is a thin C-ABI plugin with usage-observer, scheduler,
management, and declarative quota-adapter capabilities. A trusted
`X-Relay-CPA-Auth-ID` can select a specific candidate;
otherwise the plugin delegates to CPA's built-in scheduler. Usage events are
sent to Relay over the private network using a shared secret.

CPA v7's usage plugin record does not include arbitrary request headers, so
those events cannot safely be the sole tenant-billing correlation source.
Relay therefore settles from its own request-correlated terminal response and
uses plugin events for credential/failure telemetry.

Quota discovery follows the same ownership boundary. The bridge obtains one
credential by stable CPA `auth_index`, executes adapter-declared HTTP requests
through CPA's host client, and returns only normalized plan/window data. The Go
runtime contains no provider aliases, endpoints, or response parsers. Bundled
Codex/xAI definitions and administrator-supplied definitions use the same YAML
schema and execution path. OAuth tokens, account identifiers, and raw upstream
responses never cross into RelayAPI.
