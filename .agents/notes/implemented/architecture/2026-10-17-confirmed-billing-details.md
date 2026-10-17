# Agent Note: Store only confirmed charges as billing details

Status: implemented

## Problem

Request logs mixed paid generation steps with connections, prewarm, rejection and interrupted transport events. Missing usage could be charged using admission holds, price refresh could reprice pending logs, and HTTP settlement committed before its detail. WebSocket detail also exposed a nested turn ledger. These behaviors conflict with the product rule that a log is one smallest actual charge. See [settlement](../../../../internal/billing/settlement.go), [HTTP finalization](../../../../internal/app/inference.go) and [WebSocket accounting](../../../../internal/app/native_websocket.go).

## Decision

Require complete usage, a confirmed price and positive cost before writing a billing detail. Missing evidence releases the admission hold without an estimated charge or later backfill. Keep uncharged failures and missing accounting evidence in runtime logs. HTTP settlement and its single detail commit together; each charged WebSocket turn retains its existing atomic accrual and durable replay identity. Remove session/interruption summaries and nested turns from the detail API and UI. Persist the actual balance/subscription source on each new detail, selected from admission rather than mutable parent configuration.

Current lists, detail lookup and retained-detail statistics exclude legacy session summaries, estimates and zero-cost events. Historical rows are preserved, without repricing or inferred replacement steps. New daily rollups use the same confirmed-step predicate and persisted funding source. Previously archived aggregates keep their historical semantics. Existing internal WebSocket turn records remain an idempotency mechanism, not a second product-facing bill.

## Alternatives considered

Filtering only the list leaves uncharged events in storage and allows estimates to become money. Keeping the conservative hold as a charge contradicts the explicit product policy. Deleting old financial records or fabricating per-turn history would destroy audit evidence; preserve those rows without presenting them as current billing steps instead. Replacing PostgreSQL reservations or introducing a second datastore is unnecessary for this change.

## Consequences

The platform absorbs provider consumption without reliable accounting evidence. Admission holds and subscription window generations remain intact. Transaction failures leave the reservation retryable and cannot debit without a detail; replaying a committed settlement cannot charge again. Legacy charges without a saved funding source cannot always be assigned to a wallet or subscription honestly. Upstream capacity calibration remains a routing/quota concern and is separate from estimated user charges. See [billing semantics](../../../../docs/billing-step-logs.md).
