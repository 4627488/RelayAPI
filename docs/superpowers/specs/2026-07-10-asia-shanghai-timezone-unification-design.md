# Asia/Shanghai Timezone Unification Design

## Goal

Eliminate inconsistent timezone behavior across RelayAPI. The application will use one explicit contract:

- Store and transmit instants as UTC ISO 8601 strings.
- Interpret legacy timezone-less database timestamps as UTC.
- Display all user-facing timestamps in `Asia/Shanghai`.
- Define calendar days, "today", daily quotas, charts, and heatmaps using `Asia/Shanghai` boundaries.
- Rebuild historical daily aggregates so existing data follows the same rule.

This is a system-wide correction. Individual pages must not implement their own timezone parsing or formatting rules.

## Current Problems

The codebase currently mixes several incompatible behaviors:

- Most application writes use `Date#toISOString()`, while SQLite `datetime('now')` writes timezone-less UTC text.
- Shared formatters treat timezone-less text as UTC, but several components pass the same text directly to `new Date()`, which can treat it as local time.
- User-facing timestamps normally follow the browser timezone because `Intl.DateTimeFormat` has no explicit `timeZone`.
- Daily aggregation and "today" calculations use UTC date slicing, so requests between Shanghai midnight and 08:00 are assigned to the previous business day.
- Codex quota reset labels use the server process timezone and can change when the deployment environment changes.
- `datetime-local` controls use the browser timezone instead of the application's business timezone.

These differences explain why some views are correct while others are shifted or grouped under the wrong date.

## Time Contract

RelayAPI will distinguish two concepts:

1. **Instant**: an exact moment. Instants are stored and returned as canonical UTC ISO strings such as `2026-07-10T16:00:00.000Z`.
2. **Shanghai calendar value**: a date or local date-time meaningful in the application's business timezone. It is derived using the IANA zone `Asia/Shanghai` and is never inferred from the host or browser timezone.

An instant at `2026-07-10T16:00:00.000Z` therefore displays as `2026-07-11 00:00:00` and belongs to the Shanghai date `2026-07-11`.

Date-only values used as aggregation keys remain `YYYY-MM-DD` strings, but their meaning is explicitly a Shanghai calendar date.

## Architecture

Add a small shared, framework-independent time module. It will own:

- Parsing canonical ISO instants and legacy SQLite UTC strings.
- Formatting instants in `Asia/Shanghai` with stable `zh-CN` output.
- Converting an instant to a Shanghai date key.
- Adding calendar days to a date key without depending on the process timezone.
- Converting `datetime-local` values from Shanghai wall time to UTC instants and back.
- Producing Shanghai day ranges as UTC boundaries for queries.

Server and client code will import these operations instead of duplicating `new Date(value)`, timezone-offset arithmetic, or `toISOString().slice(0, 10)`.

The implementation should use built-in `Intl.DateTimeFormat` and deterministic date arithmetic unless tests expose a requirement that cannot be met reliably without a timezone library. `Asia/Shanghai` has no modern daylight-saving transition to resolve, but conversions must still use the named IANA zone rather than a deployment-dependent local timezone.

## Display and Input Behavior

All user-facing timestamps, including logs, creation/update times, expiry times, cooldowns, snapshots, OAuth state details, and quota reset labels, will be formatted with `timeZone: "Asia/Shanghai"`.

The server-rendered placeholder behavior used to avoid hydration mismatches may remain, but server and client formatting must produce the same timezone result.

For `datetime-local` inputs:

- An entered value such as `2026-07-11T00:00` means midnight in Shanghai.
- It is submitted as `2026-07-10T16:00:00.000Z`.
- Editing that stored instant restores `2026-07-11T00:00`, regardless of the user's browser timezone.

Invalid timestamps continue to render as an empty value or existing fallback rather than silently becoming a different instant.

## Daily Statistics and Quotas

Every daily feature will use Shanghai date keys:

- Request and usage daily buckets.
- Admin and tenant overview charts.
- "Today" token totals and daily quota enforcement/reporting.
- Activity heatmaps and streak calculations.
- Date range defaults, previous-day navigation, and anomaly labels.

SQLite aggregation expressions will derive the key from the UTC instant after applying the Shanghai offset. For canonical UTC strings and legacy SQLite UTC strings, the intended expression is equivalent to `date(timestamp, '+8 hours')`.

Application-side date-key helpers will produce the same result. Tests will assert parity at both sides of the midnight boundary.

Rolling duration windows such as "last 24 hours", retention cutoffs, cooldown durations, and token expiry remain instant-based and must not be changed into calendar-day arithmetic.

## Migration

Introduce a new idempotent database migration version that:

1. Recreates affected daily aggregation triggers with Shanghai date-key expressions.
2. Clears derived daily bucket tables whose keys were generated under UTC rules.
3. Rebuilds those tables from the retained request logs and usage records using Shanghai date keys.
4. Leaves source event timestamps and non-derived records unchanged.

The migration must run transactionally where supported. Re-running startup after a successful migration must not rebuild the data again.

Rows generated by SQLite with `datetime('now')` are legacy UTC instants. New application writes should prefer canonical ISO UTC strings where practical, while compatibility parsing remains in place for existing rows.

Historical periods older than retained source logs cannot be reconstructed more accurately than the available source data. Derived rows will be rebuilt from all source rows that still exist.

## Error Handling

- Invalid or empty instant strings return an explicit null result from parsing helpers.
- UI formatters preserve the current `-`, `未记录`, or empty-input fallback as appropriate.
- Input conversion rejects nonexistent or malformed local date-times instead of guessing.
- Database migration failure aborts that migration and preserves the previous schema/data transaction state.
- No behavior may depend on `process.env.TZ`, the container timezone, or the browser timezone.

## Testing

Tests will be written before production changes and cover:

- Canonical UTC ISO parsing.
- Legacy `YYYY-MM-DD HH:mm:ss` values interpreted as UTC.
- Explicit-offset timestamps normalized to the same instant.
- Shanghai display output independent of the process timezone.
- `2026-07-10T15:59:59.999Z` mapping to Shanghai date `2026-07-10`.
- `2026-07-10T16:00:00.000Z` mapping to Shanghai date `2026-07-11`.
- Shanghai `datetime-local` round trips at the date boundary.
- SQL trigger aggregation and application helpers producing identical date keys.
- Migration rebuilding historical request and usage buckets into the correct Shanghai dates.
- "Today" totals, daily ranges, heatmap navigation, and quota reset labels.
- Invalid inputs preserving documented fallbacks.

Targeted Vitest suites, the full test suite, type checking, and linting must pass before completion.

## Scope Boundaries

This change does not add user-selectable timezones, alter external Codex timestamps, or rewrite valid UTC source events. It does not change duration-based expiry, cooldown, timeout, or retention semantics. The single supported display and business timezone is `Asia/Shanghai`.
