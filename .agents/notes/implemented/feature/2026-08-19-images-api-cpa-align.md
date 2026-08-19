# Agent Note: Images API aligned with CPA

Status: implemented

## Problem

Relay billed `gpt-image-2` but had no Images adapter. Codex credentials
rewrote every non-Responses path to `/responses`, so
`POST /v1/images/generations` arrived at ChatGPT `/responses` with an Images
JSON body. xAI `grok-imagine-*` had no `size` → `aspect_ratio` mapping.
Image-only slugs were hidden in the Codex picker, which is correct, but that
was not an implementation.

## Decision

Match CPA's current Images standard, not the pre-v7.2.17 wrap.

- Codex `gpt-image-1.5` / `gpt-image-2` on `/images/generations` and
  `/images/edits` go to `{codexBase}/images/*`. Do not set
  `OpenAI-Beta: responses=experimental` on that path.
- Multipart edits become JSON data-URL bodies. ChatGPT's Codex Images
  endpoint wants JSON; official OpenAI-compatible `/images/edits` still
  forwards multipart unchanged.
- xAI imagine models rewrite OpenAI Images fields (`size`, `quality`,
  `response_format`, edit `image`/`images`) to xAI's JSON contract.
- Codex and xAI credentials implicitly serve those image slugs so operators
  do not have to list them on every account. Discovery must not wipe the
  routes.
- Reject other models on a Codex or xAI Images call. Do not wrap leftover
  models as Responses + `image_generation`; that path is dead in current CPA
  for `gpt-image-1.5`/`gpt-image-2`.
- Keep image-only slugs hidden in the Codex catalog. Vision Chat ↔ Responses
  translation stays as it is.

## Alternatives considered

**Clone CPA's Responses `image_generation` wrap.** Needed before ChatGPT
grew `/images/*`. Current CPA proxies `gpt-image-1.5`/`gpt-image-2` directly
and the wrap at the end of `ImagesGenerations` is unused. A second protocol
translator would rot.

**Send Codex Images to `api.openai.com`.** Codex credentials default to
`https://chatgpt.com/backend-api/codex`. CPA's direct path uses that base
plus `/images/generations`. Official API keys already pass through as
`openai` / `openai-compatibility`.

**Persist implicit image slugs on the credential row.** Discovery would
overwrite them, and the admin model list would mix provider capabilities
with configured chat slugs. Routes are enough.

## Consequences

`/v1/images/*` is a first-class inference path. Adding `/images/variations`
or a per-image grok-imagine price needs new billing SKUs; xAI imagine is
unpriced until an operator sets 模型设置. Codex CLI injecting
`image_generation` into Responses is already a passthrough if the client
sends the tool.
