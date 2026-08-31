# Agent Note: Sanitize Kimi tool schemas for MFJS `$ref` + `type`

Status: implemented

## Problem

Moonshot validates `tools.function.parameters` against [Moonshot Flavored JSON Schema](https://github.com/MoonshotAI/walle/blob/main/docs/mfjs-spec.md). Walle rejects a node that carries both `$ref` and `type`:

`At path '$defs.__schema20': when using $ref, type should be defined in the referenced schema instead of the parent schema`

`$defs.__schemaN` is the Zod / Codex generated wrapper shape. Relay forwarded those schemas unchanged on the native Kimi path, so one MCP/Codex tool 400'd the whole turn. The same validator block also rejects `type` next to `anyOf`.

Upstream CPA (`CLIProxyAPI` v7.2.146) now inlines local `$ref`s and strips `$defs` / `definitions` on the CPA hop (`normalizeKimiTools`). That is a different rewrite from this note: native inference still does not go through `KimiExecutor`, so Relay keeps the sibling-`type` sanitizer. Open PR [#4406](https://github.com/router-for-me/CLIProxyAPI/pull/4406) only coerces boolean subschemas and is still unmerged.

## Decision

Sanitize outbound Kimi Chat bodies in the native runtime after Responses→Chat translation. For every tool `parameters` (and `response_format` schema):

- If a node has `$ref` and `type`, copy `type` onto the referenced schema when it is missing, then delete `type` from the parent (Walle's own `SimplifyRemoveType`).
- If a node has `anyOf` and `type`, copy `type` into branches that lack one, then delete it from the parent.

Do not bump CPA. Native inference does not go through `KimiExecutor`.

## Alternatives considered

**Wait for CPA and bump `CLIProxyAPI`.** v7.2.146 inlines `$ref` on the CPA hop, but native Kimi traffic still misses that pass. The sibling-`type` sanitizer stays in Relay.

**Port CPA PR #4406 only.** That fixes `outputSchema: true`, not this `$ref` + `type` 400.

**Drop or flatten `$ref`s.** Loses recursive / shared structure that MFJS actually allows when `$ref` is a pure pointer into root `$defs`.

**Add `moonshotai/walle` as a dependency.** Useful for tests, not needed to apply the two sibling-`type` rules the validator already names.

## Consequences

Codex and Chat clients can send Zod-style `$defs.__schemaN` tools to Kimi without a 400. Schemas that already satisfy MFJS stay byte-identical. Other MFJS rejections (boolean subschemas, non-`#/$defs/` refs) are still possible and should be added only when a real payload hits them.
