# Agent Note: Version the Codex provider contract and give native settings one owner

Status: implemented

## Problem

[The current launcher](../../../../internal/rai/codex.go) always enables provider WebSockets, while [the catalog policy](../../../../internal/app/native_models.go) still expresses per-model transport through `prefer_websockets`. Codex 0.163.0 no longer reads that ModelInfo field. Current tests can therefore assert correct JSON while missing a wrong transport decision. The launcher also imports root config model/effort by mtime while native Codex profiles and project layers can own different settings. The [existing launcher decision](../../implemented/feature/2026-08-25-rai-agent-launcher.md) predates the current profile-file contract; the [complete ModelInfo decision](../../implemented/feature/2026-08-19-codex-catalog-modelinfo.md) remains necessary for old clients and hidden rows.

## Decision

The [interoperability analysis](../../../../docs/rai-codex-interoperability.md) records the official 0.163.0 source contract. Session responses now carry version 1 Codex provider capabilities covering all selectable models and resolved aliases. rai generates WS/search/remote-compaction settings from that contract; missing or unknown versions use HTTP. Static profiles retain login-time facts and require reconfiguration after policy changes. Existing legacy catalog fields and complete hidden tombstones remain for compatibility.

The embedded compatibility executor adapts HTTP/WS compaction v2 through CPA's existing summary/capsule codec and normal usage pipeline, including Chat-only upstreams. Generic openai credentials use CPA's canonical compatibility routing name. models.dev input budgets, tool flags, modality, reasoning and whitelisted priority modes enrich the catalog; all capability facts, including unpriced models, persist atomically with prices in the existing PostgreSQL runtime settings. First-party OpenAI facts can enrich official slugs, while aggregator facts cannot replace them.

Native Codex profile files share CODEX_HOME and leave root configuration intact. configure, unconfigure and explicit sync accept --codex-profile. Launches selecting a native profile skip root mtime preference import; the legacy root workflow retains its existing import and recovery behavior. Provider IDs avoid inherited auth collisions. The helper timeout is 30 seconds and refresh interval one minute; Codex receives credentials through the helper without an extra rai bearer environment variable. User sandbox and approval policy remain owned by Codex.

## Alternatives considered

Deleting all old metadata and restore code immediately would break still-supported clients and leave existing managed configuration without recovery. Keeping all declarations unchanged preserves the appearance of compatibility while current clients ignore key fields. A separate CODEX_HOME isolates settings but splits history and integrations. Patching Codex or adding another local proxy would introduce lifecycle and maintenance cost before the existing provider protocol has been exhausted.

## Validation

Pinned real Codex 0.163.0 tests verify persistent command auth, native CLI profile use, same-process HTTP 401 renewal, HTTP/WS quota and context adoption, and HTTP/WS compaction followed by a continuation through the embedded Chat adapter. Protocol tests verify usage association; isolated PostgreSQL tests verify unpriced capabilities survive reopening. CI now installs the pinned client and runs both module test sets. Ordinary tests remain opt-in for the external client. Desktop profile selection and WS expiry recovery are separate unverified cases; app-server itself rejects the native --profile flag.

## Risks

A provider-wide transport choice must cover every model selectable in the session. A launch-time model check alone is insufficient. Opaque rotating bearer tokens affect Codex catalog cache identity; do not spoof ChatGPT identity to preserve caches. Summary compaction does not preserve proprietary native reasoning state. Real-upstream quality, Fast/search availability, and additional provider implementations require separate tests; a contract whitelist is not an online validation claim. CLI app-server success does not prove Desktop selection or TUI rendering.
