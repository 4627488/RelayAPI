# Agent Note: Assign models from users with one shared batch flow

Status: implemented

## Problem

Assigning model access required opening an account, its authorization panel and a separate form. Shared subscriptions could only be created one user at a time. Administrators could not quickly compare selected recipients with the total share they were about to allocate.

## Decision

Use the existing user table as the primary recipient selection surface, with search, multi-selection, a direct per-user action and existing authorization counts. Reuse one lazy assignment dialog from users, model accounts and account details. Keep balance access and shared quota as explicit settlement choices. Shared batches apply one editable public subscription name, per-user share and expiry; offer fixed shares or even division of nominal remaining allocation, with an up-front preview. Existing enabled, unexpired grants on the chosen source are skipped, including scheduled grants, to avoid accidental duplicate assignment. Existing grant editing stays in account details.

The existing child creation endpoint accepts tenant_ids for shared grants as well as balance grants. Shared creation wraps existing single-grant validation in a transaction, locks the parent and validates all selected users before creation. Any failure rolls back the batch. Frontend failures refetch grants before allowing another submission, preserving choices and edited names.

## Alternatives considered

A new allocation page would duplicate both the user list and model account management. Keeping separate balance and shared assignment forms would preserve inconsistent bulk behavior. Silently editing or replacing an existing grant could overwrite a user's custom model scope or lifecycle. Reserving exactly 100% is also inappropriate because the existing system intentionally supports oversubscription; show the projected amount and a warning instead.

## Consequences

No new navigation concept, database table or tenant permission policy is introduced. Even division concerns nominal allocated percentages rather than live remaining usage. Browser coverage checks batches, common expiry, existing grant skipping, retry state, direct user selection, mobile layout and accessibility. PostgreSQL integration coverage verifies batch validation, deduplication and consistent lifecycle; it requires TEST_DATABASE_URL.
