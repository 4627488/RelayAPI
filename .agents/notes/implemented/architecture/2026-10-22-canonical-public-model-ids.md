# Agent Note: Project author-qualified public model IDs without migrating policy

Status: implemented

## Problem

Runtime model IDs are also used by subscription grants, prices, historical requests and credential routes. Renaming them globally to author/model would alter several protected policy seams. Client metadata nevertheless benefits from stable author namespaces instead of transport-specific names or ambiguous bare slugs.

## Decision

[Model ID projection](../../../../internal/app/model_ids.go) generates collision-free aliases for recognizable model families and exact known first-party models.dev facts. Preserve qualified IDs, explicit user aliases, unknown models and model-name suffixes. Never strip an arbitrary namespace to grant access. Resolve generated IDs before the existing authorization, admission, price and upstream routing paths, including every WS turn. User aliases can target the generated IDs without changing their precedence or introducing general alias chaining.

Standard metadata lists prefer generated IDs, while legacy detail lookups retain the requested ID. Codex retains complete hidden legacy rows for its bundled-catalog merge. Canonical rows inherit original capability and descriptive metadata. rai session retains both callable IDs so saved legacy preferences still validate, while default selection prefers a generated ID. Metadata and inference ETags use the same effective aliases. See [the public contract](../../../../docs/model-ids.md).

## Alternatives considered

Renaming stored models would force a migration of grants, prices, settings and logs. Merely adding a prefix to metadata would advertise IDs that inference rejects. A global namespace-stripping fallback would conflate authors and could bypass policy or shadow existing published IDs. Inferring the author from the credential provider would label Grok hosted through Codex as OpenAI. All are rejected.

## Validation and limits

Tests cover canonical/legacy resolution, ownership collisions, permissions, cross-protocol catalog/detail queries and WS rewrites. The pinned real Codex test reads the production canonical catalog and adopts its context and priority capability. Original IDs remain authoritative in stored policy. This is not a complete OpenRouter model-name registry; uncertain names remain unchanged and the model slug spelling is preserved.
