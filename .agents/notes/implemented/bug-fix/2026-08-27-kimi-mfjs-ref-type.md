# Agent Note: Let CPA own Kimi MFJS `$ref` sanitization

Status: implemented

## Problem

Moonshot validates `tools.function.parameters` against [Moonshot Flavored JSON Schema](https://github.com/MoonshotAI/walle/blob/main/docs/mfjs-spec.md). Walle rejects a node that carries both `$ref` and `type`:

`At path '$defs.__schema20': when using $ref, type should be defined in the referenced schema instead of the parent schema`

`$defs.__schemaN` is the Zod / Codex generated wrapper shape. Relay briefly kept a sibling-`type` sanitizer on the leftover native Kimi path. Production inference now goes through embedded CPA, so that pass never ran on live traffic.

## Decision

Drop `sanitizeKimiToolSchemas` from `internal/upstream`. Production Kimi requests hit `KimiExecutor`, and CPA `v7.2.147` `normalizeKimiTools` inlines local `$ref`s and strips `$defs` / `definitions` before Moonshot sees the body.

Do not keep a second MFJS rewrite in Relay. Open PR [#4406](https://github.com/router-for-me/CLIProxyAPI/pull/4406) still only covers boolean subschemas; add a new pass only when a real payload hits a remaining Walle rule.

## Alternatives considered

**Keep Relay's sibling-`type` sanitizer.** It never ran on the embedded CPA hop. CPA's inlining already removes the `$ref`+`type` pair that 400'd Codex tools.

**Port CPA's inliner into the leftover native runtime.** `startNativeRuntime` is unused; duplicating `normalizeKimiTools` would rot.

**Port CPA PR #4406.** That fixes `outputSchema: true`, not this `$ref` + `type` 400, and it is still unmerged.

**Add `moonshotai/walle` as a dependency.** Useful for tests, not needed once the production hop owns the rewrite.

## Consequences

Kimi tool schemas are rewritten only by CPA. Relay no longer moves sibling `type` off `$ref` / `anyOf`, and it does not touch `response_format`. Boolean subschemas and other MFJS rejections stay CPA gaps until a real payload hits them.
