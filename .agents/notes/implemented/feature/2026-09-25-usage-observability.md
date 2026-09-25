# Agent Note: Overview and usage observability

Status: implemented

## Problem

The tenant and administrator overviews exposed totals without enough context to diagnose failures, understand spending, or act on account and entitlement health. Request retention also means historical totals and diagnostic samples have different coverage.

## Decision

Compose both overviews and usage analysis from shared default shadcn components. Show selectable reporting periods, weighted success and cache rates, payment sources, searchable and sortable attribution, response percentiles, error groups, and explicit sample coverage. Tenant views include current balance and independent entitlement windows; administrator views include current account health and provider attribution. Account and subscription pages reuse the relevant operational summaries. CPA-Manager-Plus informed the information organization; RelayAPI's own data and accounting remain authoritative.

Extend the existing usage response with period metadata and an additive observability object. Monetary and usage totals continue to merge retained logs with archived daily rollups. Percentiles use retained step rows only; first-token and first-response samples exclude absent or invalid values while retaining measured zero. Failure groups and provider attribution cover retained rows, and provider data is included only for global administrator reports. Tenant predicates apply to every diagnostic query. Independent secondary overview failures keep available data visible with warnings.

## Alternatives considered

Reconstructing percentiles from daily aggregates would fabricate unavailable distributions. A separate analytics datastore would add operational cost without resolving missing historical samples. Importing the reference project's visual theme or data model would conflict with the default shadcn requirement and RelayAPI's subscription accounting. Summing daily, weekly, and monthly entitlement windows would overstate usable capacity.

## Consequences

The report adds aggregate scans over retained request logs; high-volume deployments should measure query latency before adding indexes or preaggregation. Archived requests remain visible in totals but cannot contribute to detailed diagnostics. Browser tests cover weighting, missing observations, scope, refresh failures, keyboard accessibility and narrow viewports. PostgreSQL integration coverage is in usage_observability_test.go and requires TEST_DATABASE_URL; it is skipped without a test database.
