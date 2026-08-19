# Agent Note: One QueryLogs aggregate and dashboard rollup merge

Status: implemented

## Problem

`QueryLogs` scanned the same filter three times: `COUNT(*)`, `percentile_cont` summary, then the page. The workbench always shows the summary, so percentiles stay, but `count(*)` was already in the summary select.

`Dashboard` summed only live `request_logs` for 30 days. After retention compact, those days live in `usage_daily_rollups`. `UsageReport` already merged rollups; the dashboard undercounted versus `/api/usage`.

`UsageReport` model/daily/user slices already merge rollups. Per-key slices cannot: rollups are keyed by `(day, tenant_id, model)` and have no `api_key_id`.

## Decision

Use the summary `count(*)` as `LogPage.Total`. Merge `usage_daily_rollups` into dashboard 30-day totals the same way `UsageReport` merges grand totals. Leave per-key usage on live logs only.

## Alternatives considered

**Approximate or drop P50/P95.** That would change workbench numbers.

**Add `pg_trgm` for ILIKE search.** Search is optional and rare; an extension is not justified yet.

## Consequences

List pages do one aggregate scan plus the item page. After compaction, dashboard 30-day request/token/cost totals match usage. In-window installs (all rows still in `request_logs`) see identical dashboard numbers plus zero from empty rollups.
