# Agent Note: Model settings overrides

Status: implemented

## Problem

models.dev does not publish `kimi-k3-256k`. Official public docs only list
`kimi-k3` (1M context, always-on thinking, `reasoning_effort` `low|high|max`).
Kimi Coding Plan / Allegro still exposes `kimi-k3-256k` as the same K3 family
capped at 256k. Relay's template therefore advertised 256k / `medium` /
`prefer_websockets=true`, which is wrong for a Chat-only K3 variant.

Hardcoding one slug would rot the next time Moonshot ships another window.

## Decision

Rename the admin 模型定价 page to 模型设置. Keep prices. Add a
`model_settings` overlay for Codex metadata: display name, context, max
output, reasoning efforts, default effort, input modalities, WebSocket
preference, and provider. Overlay order is admin > models.dev > template.
Seed `kimi-k3-256k` as K3-256k: 262144 / 131072 / `low,high,max` default
`max` / text+image / `prefer_websockets=false` / `moonshotai`. Also alias
it to `kimi-k3` for pricing so it inherits the K3 catalog rate.

## Alternatives considered

**Hardcode only `kimi-k3-256k` in Go.** Fixes today, repeats for the next
missing slug.

**Treat `kimi-k3-256k` as a models.dev lookup of `kimi-k3` and shrink the
window.** Prefix matching would also steal 1M facts for any future
`kimi-k3-*` slug.

## Consequences

Operators can correct models.dev gaps without a deploy. Changing an overlay
bumps the Codex catalog ETag. Request-time thinking wire mapping is still a
follow-on.
