# Agent Note: Adapt Codex HTTP to the ChatGPT website backend

Status: implemented

## Problem

Relay treated Codex as an OpenAI-compatible Responses host. ChatGPT's website backend (`chatgpt.com/backend-api/codex`) is not: `input` must be a list, `store` must be `false`, `stream` must be `true`, and `max_output_tokens` is rejected. The admin 模型测试 button and ordinary Chat Completions probes therefore 400'd. Production also sets `RELAY_UPSTREAM_WEBSOCKETS=false` while the catalog still advertised `prefer_websockets=true`, so Codex clients opened a WebSocket and then failed the real turn.

## Decision

Rewrite Codex Responses bodies after Chat→Responses translation: wrap a string `input` as a user message list, force `store=false`, drop `max_output_tokens` / leftover `max_tokens`, and always send `stream=true` upstream. When the client asked for a non-stream reply, collect `response.completed` (or a JSON fallback) and continue the existing `responses-to-chat` path. Apply the same field rewrite to WebSocket `response.create` frames. When upstream WebSockets are disabled, the served Codex catalog sets `prefer_websockets=false` and the ETag token records `|http`.

Do not change production `.env`. Do not treat Kimi or xAI 400s as this bug.

## Alternatives considered

**Change the admin probe to a streaming Responses body.** That would hide the same mismatch for Chat Completions clients and Codex CLI HTTP turns.

**Turn WebSockets on in production.** The catalog lie is the client-visible contract; HTTP is the working path on this host.

**Rewrite only official `gpt-*` slugs.** All `provider=codex` credentials share the website backend.

## Consequences

Admin 测试模型, Chat Completions, and string-input Responses against Codex website credentials succeed. Clients honor the HTTP transport when the operator has disabled WebSockets. The official catalog template still defaults `prefer_websockets=true` for hosts that leave the flag on.
