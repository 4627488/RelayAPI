# Agent Note: Drop unused store.Reserve and store.Settle

Status: implemented

## Problem

`store.Reserve` and `store.Settle` implemented a balance-only reservation/refund pair that wrote `billing_ledgers` kinds `reservation` / `settlement` / `refund` without going through `request_reservations`. `rg` found zero callers. Every billable inference path uses `AdmitRequest` plus `SettleRequestReservation` / `ReleaseRequestReservation` / `ReclaimExpiredReservations`.

Keeping the old helpers invited a second, non-idempotent way to move tenant balance.

## Decision

Delete `Reserve` and `Settle`. Leave `Credit` and the reservation finishers. Do not change ledger rows that Admit/finish still write.

## Alternatives considered

**Keep them as primitives for tests.** No test called them. New tests should use `AdmitRequest`.

**Repoint them at Admit/SettleRequestReservation.** That would preserve a misleading API that cannot express child-quota windows or request-id idempotency.

## Consequences

Balance movement for inference has one owner. A future "just reserve N nano-USD" helper must be a new, documented API if it is ever needed.
