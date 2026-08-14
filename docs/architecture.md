# RelayAPI rewrite architecture

## Goal

RelayAPI is a Codex-first, multi-tenant policy and accounting gateway. Provider
execution is isolated behind `internal/upstream.Runtime`; policy, billing and
HTTP code must not import executor registries or provider implementation types.
The current compatibility implementation adapts selected
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) behavior behind that
boundary while focused native adapters replace it provider by provider.

The backend also owns the product-facing user lifecycle: first-user setup,
single-use invitations, invited registration, user sessions, user-created API
keys, administrator capabilities, and administrator/user usage reports. An
administrator is a normal user with an additional permission flag, not a
separate account or access-key session. It intentionally contains no frontend
assets.

## Request flow

```text
       Codex / OpenAI client
              |
              v
 RelayAPI: tenant key -> policy -> optional balance reservation
              |
              v
 upstream runtime: adapter -> model router -> provider credential
              |
              v
 RelayAPI: usage parser -> settlement -> audit log
```

RelayAPI deliberately exposes a focused inference surface:

- Responses, Chat Completions, images, videos and models under `/v1/*`
- Codex compatibility paths under `/backend-api/codex/*` and `/openai/v1/*`
- Responses WebSocket transport for Codex and xAI routes

Anthropic Messages and Gemini-native `/v1beta/*` are intentionally rejected.
This keeps the product contract aligned with its Codex-first provider set:
Codex, xAI, Kimi and OpenAI-compatible endpoints such as Aliyun Bailian.

The caller's Relay key is replaced with the private CLIProxyAPI API key. Query
strings, request bodies, status codes, SSE events, and end-to-end headers are
preserved. Hop-by-hop headers are removed. WebSocket upgrades are tunneled.

## Model and pricing policy

`GET /v1/models` is dynamically served by CLIProxyAPI, so a newly configured
model is immediately available. Empty tenant/key allowlists mean all models;
allowlists support exact names, `*`, and glob patterns.

Prices are local accounting metadata, not a model allowlist. Resolution is
administrator override > synced Models.dev catalog > bundled last-known-good
catalog. Aliases are resolved before lookup, and CPA dimensions may apply
validated multipliers for API group, auth index, service tier, reasoning
effort, endpoint, executor, or model alias. The resolved modality-aware integer
price and catalog version are snapshotted with every request. Text uses input,
cached-input, cache-write, output, and reasoning rates. Image generation adds
image-input, cached-image-input, and image-output rates; provider-reported
modality token counts are authoritative, so quality and size are reflected by
actual output tokens instead of a lossy per-image estimate:

- `UNPRICED_MODEL_POLICY=allow` (default): forward an unknown model, record its
  usage, mark pricing incomplete, and charge zero.
- `UNPRICED_MODEL_POLICY=deny`: reject billable calls whose model has no local
  price.

This separation is what lets the gateway support every model exposed by
CLIProxyAPI without silently inventing prices.

## Reliability and security

- Inference admission is bounded before Relay reads the request body. A full
  CPA bulkhead waits for a short, bounded interval and then returns a
  retryable `503`, preventing an unbounded request queue from becoming an
  implicit memory queue.
- CPA transport failures feed a circuit breaker. After repeated failures the
  circuit rejects traffic for a cooldown period and permits only one recovery
  probe, so an OOM-restarting CPA is not flooded as soon as its port reopens.
- Request bodies default to 1 GiB (configurable up to 64 GiB), aggregate
  in-flight request bodies have a separate 8 GiB budget (configurable up to
  256 GiB), response-log captures
  remain bounded, and the CPA connection pool cannot exceed the inference
  concurrency limit.
- SSE and WebSocket operations have no whole-request client timeout. Only the
  wait for CPA response headers is bounded, so long Codex and Claude Code
  generations are not terminated by the gateway.
- Inference and control traffic use separate HTTP transports. Long-lived
  inference streams cannot exhaust the connections used by readiness checks,
  management, OAuth, or quota probes and trigger a false watchdog restart.
- PostgreSQL row locks make balance reservation/settlement atomic.
- A request is settled only after usage is found; upstream errors are refunded.
- Responses without usage are refunded and remain visibly marked as
  pricing-incomplete, so missing provider usage cannot lock tenant funds.
- Request bodies and captured response tails are bounded.
- Routine management endpoints expose typed, validated credential/OAuth and
  runtime-policy operations using CPA's redacted responses. Full configuration
  access is explicitly confined to authenticated Relay administrators.
- Health checks test PostgreSQL, the embedded runtime and configured upstream
  credentials.

## Deployment boundary

The embedded CPA listener binds to an ephemeral loopback address and uses a
random process-local key. Tenant clients receive only `relay_*` keys. Provider
credentials are encrypted in PostgreSQL and loaded directly into the embedded
runtime.

## Embedded CPA boundary

Relay does not call provider executors directly. HTTP, SSE and WebSocket
requests enter CPA's complete public handler through a loopback connection, so
prewarm, replay, compaction, credential pinning and multi-turn state retain CPA
semantics. Relay observes terminal response events only for accounting and
does not translate protocol frames.

Relay request logs have separate summary and detail retention. Sensitive
headers are redacted; bodies carry original byte counts and truncation flags.
Successful requests retain summaries only by default. Error bodies are capped
at 32 KiB, and identical client/forwarded bodies are stored only once.
The summary stores tenant/key display snapshots, CPA execution identity, TTFT,
token and modality breakdown, errors, and the immutable pricing snapshot. Detail
stores client and translated requests, upstream response, stage timings, and
structured error context.
