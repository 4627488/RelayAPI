# Agent Note: CPA provider and protocol parity

Status: implemented

## Problem

The bridge already mounted CPA's public inference router but Relay rejected Claude and Gemini paths before authentication, accepted only a focused provider subset, omitted Devin and Meta executors, and assumed every downstream WebSocket started with response.create. CPA realtime client secrets could not authenticate through Relay, and the shared loopback key collapsed session ownership across tenants.

## Decision

Use one bridge-owned normalization boundary for CPA's built-in executors, expose their supported credential and OAuth flows in the existing account UI, and delegate protocol translation to CPA. Rebuild static provider catalogs on refresh. Preserve Relay's tenant/model/subscription checks and credential pinning. Gemini URL models are authoritative for admission. Counting and local realtime credential issuance have known zero cost and still pass admission. Model aliases inherit only metadata retained by catalog policy filtering.

Realtime connects its upstream without waiting for a client frame, validates session model changes, accounts for server-created response turns, and retains native terminal usage when CPA's direct transport does not publish executor usage. Encrypt temporary CPA credentials with the issuing Relay key, model and expiry; revalidate the original key on every use. Carry the verified Relay key ID into CPA's authenticated principal through the private loopback boundary, preserving CPA's session ownership checks. AI Studio upstream workers connect through an administrator-only credential-scoped channel rather than the tenant inference WebSocket path.

## Alternatives considered

A second Anthropic/Gemini adapter would duplicate CPA's evolving translators, beta policies, thinking/signature handling and refresh behavior. Merely removing the product rejection left incomplete executor registration, missing Gemini admission metadata, wrong counting charges, realtime handshake deadlocks and unusable temporary credentials. Passing raw CPA temporary credentials through Relay would lose issuing-key revocation and model policy. Treating the shared loopback key as the user identity would merge unrelated realtime session owners.

## Consequences

The capability scope and protocol matrix are documented in docs/cpa-capabilities.md. External plugin deployment and standalone CPA configuration/lifecycle remain separate integration work, rather than pretending uninstalled plugins are built-in providers. Mocked protocol and security regressions supplement existing tests; real-account, WebRTC/SIP and browser-worker behavior still require deployment acceptance. Existing conservative accounting remains when complete generation usage is unavailable.
