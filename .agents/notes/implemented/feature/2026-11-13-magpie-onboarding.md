# Agent Note: Stable Magpie imports and explicit interface checks

Status: implemented

## Problem

The import link embedded one balance expression per grant and window. Magpie limits balance_path to 200 bytes, so ordinary subscription growth could invalidate an entire import. The paths also bound the user's imported provider to the grant IDs present that day. Import generation depended on a successful quota query, and the browser immediately left the key page. Temporary upstream failures and missing observations could look like absent or depleted plans.

## Decision

Use Magpie's existing support for a string-valued balance part. A constant expression reads available cash and a live subscription summary. The summary lists each grant's model scope, independent windows, in-flight reservations, expiry and UTC resets without summing incompatible quotas. Preserve the original keyed window paths for already imported providers, while representing unknown or stale windows with explicit state and null remaining. Active unavailable and cash-billed grants remain visible, matching admission's model filtering and generation rules. No new datastore or upstream quota probes are introduced.

Generate imports independently of quota availability. Give each site/key pair a stable provider ID and readable name, keep configuration in a site dialog and open import only on a user click. Provide installation and manual configuration fallbacks. The existing authenticated endpoint returns no-store configuration; tenant ownership is checked before any key reveal.

A session-protected interface check calls the same public catalog and balance handlers. Only explicit generate=true invokes Responses, through normal key authorization, limits, reservation, logging and settlement. It uses a 45-second deadline and bounded response capture; closing the dialog propagates cancellation. The check reports a request ID but does not claim to have verified public DNS, TLS or the user's Magpie network.

Upstream authentication failures are identified as upstream 502 errors so clients keep valid Relay keys. Cash depletion remains 402 and subscription quota depletion uses 429; short rate limits provide the actual sliding-window wait rather than extending the window on rejection. Daily token resets follow the existing server-local civil day, are reported as UTC instants and are not treated as immediately retryable. Unknown reset times are never invented. HTTP and WebSocket share credential refresh and terminal-response semantics. Invalid or unavailable quota projections are excluded from native Codex quota snapshots too.

## Alternatives considered

Truncating a generated path would hide arbitrary subscriptions and keep imports tied to old IDs. Summing all windows would misrepresent simultaneous limits and model-specific grants. Pretending to be a remote Magpie instance would require a second discovery/quota protocol and risk exposing upstream identities. Reusing the administrator account test would bypass user admission and billing. Automatically sending a model request on opening the dialog would spend user quota without an explicit test action.

## Consequences

Magpie's generic balance card presents subscription details as live text rather than one graphical meter per window. New or removed grants appear on refresh without reimporting. Old grant-specific imports remain readable while those grants exist; reimport once to obtain the stable expression. Magpie's own provider parser and the installed client are used for interop validation, alongside normal server/frontend tests. Real-account generation and public reverse-proxy behavior require separate environment-specific verification; no production deployment is implied by local checks. Model capability/price discovery and disjoint invoice rows are documented in the companion Magpie model discovery note.
