# Agent Note: Align key discovery with model entitlements and inherit future models

Status: implemented

## Problem

The key editor selected a snapshot of all current models by default and repopulated it when subscription metadata arrived. That encoded a fixed allowlist instead of the intended empty-list inheritance policy, preventing future balance and subscription grants from flowing into newly created keys. It also maintained a second catalog from tenant allowlists and subscription snapshots. Client setup discovery independently expanded these policies and could emit patterns or unpublished models. Single-model metadata requests did not all use the filtered catalog path, and a stale alias could leave a native slug visible even though inference resolves that slug to a forbidden target.

## Decision

Keep inference authorization as the key model restriction intersected with the union of ordinary tenant permissions and active subscription grants. Express that intersection explicitly in AllowsModel. New keys default to the empty-list inheritance policy and never fill that list when the candidate catalog arrives. Alias presets preserve inheritance. Editing retains explicit restrictions. Key model options come from the existing tenant model catalog instead of another local policy calculation.

Build client-visible IDs from live runtime models and the same one-hop alias resolution and target authorization used for inference. Reuse this projection for protocol catalogs, catalog revisions, rai session discovery and client setup. Setup additionally verifies key ownership and current key/account validity. Model list and detail GET/HEAD requests across OpenAI, Gemini and Codex-compatible paths use filtered local runtime catalogs without provider inference, quota reservations or arbitrary upstream credential selection. Reject unauthorized detail requests before catalog access, return not-found for unpublished targets, and recheck authorization before conditional 304 responses. Scope caching to private revalidation. Keep Codex's hidden denied-model overrides, which prevent its bundled defaults from resurfacing, while omitting unauthorized synthetic aliases.

## Alternatives considered

Preselecting today's models looks like all-model access but freezes future permissions. A second frontend or client-setup policy parser drifts on wildcards, inactive grants and model publication. Hiding models when quota is exhausted confuses temporary admission state with authorization and would make it harder to inspect a valid subscription. Passing model-detail requests through ordinary inference can bypass path-based model identification and expose an arbitrary account's metadata. Removing Codex hidden overrides would allow bundled denied models to reappear in its picker.

## Consequences

No billing, reservation or subscription routing policy changes. Tests cover dynamic inheritance versus explicit selection, delayed candidate loading, tenant/catalog/key parity, model metadata and aliases, shadowed names, GET/HEAD compatibility paths, permission revocation with an old ETag, and unpublished-model handling. Existing keys are not migrated or expanded.
