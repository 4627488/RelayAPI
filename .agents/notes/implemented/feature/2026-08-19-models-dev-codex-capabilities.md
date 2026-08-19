# Agent Note: models.dev Codex capabilities

Status: implemented

## Problem

Relay already emitted a complete Codex `ModelInfo` for every published slug, but
the facts were one optimistic template: 256k context, `none/low/medium/high`,
`prefer_websockets=true`. That is wrong for Kimi and DeepSeek (K3 is 1M with
`low/high/max`; K2.5 is toggle-only; Chat-only providers should not prefer
WebSocket). Hardcoding a family table would rot. Other OSS projects already
solve this with a living catalog.

## What other projects do

**CPA** embeds and remotely refreshes a private `models.json`, clones `gpt-5.5`
for unknown slugs, then deletes `apply_patch` and sets `prefer_websockets=false`
for custom models. Relay must not take that catalog or that apply_patch policy.

**sub2api** rewrites custom `/v1/models` to `{models:[{slug}]}` and relies on
Codex's fallback. That is the failure mode we already fixed.

**LiteLLM** fetches GitHub `model_prices_and_context_window.json` at startup.
It has context and capability bools, not Codex reasoning *levels*.

**OpenCode / models.dev** publishes `https://models.dev/api.json`. First-party
rows already have the fields Codex needs: `limit.context`, `reasoning`,
`reasoning_options` (`toggle` / `effort` values), and `modalities.input`.
Aggregator copies of the same slug disagree (for example qiniu marks
`kimi-k2.5` as `reasoning: false`).

## Decision

Reuse the models.dev fetch Relay already runs for prices. Parse capabilities
even when a model has no public price. Prefer first-party providers. Overlay
onto non-OpenAI slugs after `CompleteCodexCatalogItem`. Keep
`apply_patch=freeform`. For Moonshot and DeepSeek, set
`prefer_websockets=false` and drop verbosity / multi-agent. Reasoning mapping:

- effort values are authoritative (so K3 does not invent a fake `none`)
- toggle only → `none` + `high`
- reasoning true with empty options → `high` only
- otherwise → `none` only

Persist priced `RawJSON` as before; rebuild the in-memory index from those
rows on boot; refresh the full capability set ~3s after start and on admin
sync. ETag token is `codex-modelinfo-v2|<models.dev version>`.

Do not fetch CPA's `models.json`. Do not embed the 4MB `api.json`.

## Alternatives considered

**Hardcoded Kimi/DeepSeek/Grok profiles.** Accurate on day one, stale when
Moonshot ships K4.

**Fetch CPA's catalog at runtime.** Couples Relay to another project's
schema and conservative tool policy.

**Overlay official OpenAI slugs too.** models.dev can disagree with the
bundled Codex contract the client already has for `gpt-*`.

## Consequences

Codex pickers show Kimi K3 as 1M / low-high-max and do not offer a
Responses WebSocket to Chat-only providers. Admin price sync also refreshes
picker metadata. Request-time thinking wire mapping (K2.5 `thinking.type`
versus K3 `reasoning_effort`) is still a follow-on.
