# Agent Note: Model management table and account test

Status: implemented

## Problem

The admin model-account page used two-column cards: badge piles, truncated model chips, quota widgets, and a single “管理” action. Operators could not scan status vs published models, and there was no way to fire a real upstream request without minting a user key and paying Admit/Settle.

## Decision

Replace the card grid with the same Card+Table pattern as Users/Pricing. Each row shows account, provider/source, one status word, published-model summary, a one-line quota hint, and **测试 / 管理**. `POST /api/admin/providers/accounts/{id}/test` asks the in-process runtime for one non-streaming `/v1/chat/completions` ping, pinning `X-Relay-Upstream-Credential-ID`. It does not Admit, Settle, or write a user request log. The observed upstream status/body is returned as-is (`ok`, `status_code`, `latency_ms`, `preview`/`error`). The model must already be in that account’s published list. A failed availability status still records on the credential circuit, same as a live request.

## Alternatives considered

**Catalog-only ping (`DiscoverCredentialModels`).** Already available as “刷新” in 管理; it does not prove inference.

**Route the test through `handlePublic`.** Would require a tenant key and would bill. The probe is an operator diagnostic.

**A separate runtime `Probe` that skips circuit accounting.** A 401/429 on test should look like production; sharing `Serve` keeps one path.

**Keep cards and add a test button.** Cards were the readability complaint.

## Consequences

Admin tests consume a small amount of real upstream quota. Operators should not hammer paid models. Preview text is clipped to 400 runes and must not include credential secrets (request bodies never echo keys). The public `/v1/*` contract and error codes are unchanged.
