# Agent Note: Unify account management and access allocation

Status: implemented

## Problem

[ProvidersView](../../../../web/src/components/providers-view.tsx) and [AdminSubscriptionsView](../../../../web/src/components/admin-subscriptions-view.tsx) offered separate navigation entries and duplicated account lists, names, health summaries and settings. Operators had to identify the same upstream credential again to grant access. Parent subscription names also created a second editable identity for a single credential.

## Decision

Use model accounts as the administrator's only account and allocation entry point. The compact list combines credential identity, status, published models, upstream quota and enabled user counts; connection and runtime request details remain in the existing account sheet. Embed allocation in the same sheet under User Access, bound strictly by upstream_credential_id. A missing match produces a retryable empty state rather than selecting another account. Preserve unmetered balance grants and observed quota shares; they enforce different admission policies and are not redundant concepts. Preserve parent allowlists as authorization model restrictions, distinct from published models. Remove the second account-name editor while preserving stored names on rule updates.

Historical grants remain in a separate tab within model accounts. Their editor receives all parent records so grants can migrate to current accounts. Canonicalize the legacy administrator subscription URL to accounts, preserving personal subscriptions. Refresh account-level grant summaries after mutations; expose quota or authorization read failures rather than presenting them as zero grants. Unsaved account drafts prevent entering allocation until they are saved or discarded.

## Alternatives considered

Keeping both pages with cross-links preserves duplicate selection and identity. Putting the entire old allocation page behind a general tab also forces operators to select the same account twice. Deleting parent and child subscription storage would remove required strict routing and quota reservation semantics; the simplification belongs in presentation and navigation, not admission.

## Consequences

Existing APIs and reservation policies remain compatible. Account details and allocation remain lazy-loaded. Browser coverage exercises desktop and mobile account-to-grant identity, fixed-account assignment, accessibility, and administrator-only route canonicalization. Existing allocation coverage retains quota and grant operations. Provider UI references were CPA Management Center and Sub2API; their provider grouping and account sharing informed the layout without importing their plugin or group hierarchy.
