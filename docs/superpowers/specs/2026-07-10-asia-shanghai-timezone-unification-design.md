# Configurable Global Timezone Unification Design

## Goal

Eliminate inconsistent timezone behavior across RelayAPI. The application will use one explicit contract:

- Store and transmit instants as UTC ISO 8601 strings.
- Interpret legacy timezone-less database timestamps as UTC.
- Display all user-facing timestamps in one administrator-configured IANA timezone.
- Define calendar days, "today", daily quotas, charts, and heatmaps using that timezone's boundaries.
- Rebuild historical daily aggregates so existing data follows the same rule.

The default timezone is `Asia/Shanghai`. Administrators can change it from the global settings interface to any valid IANA timezone.

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
2. **Business calendar value**: a date or local date-time meaningful in the configured global timezone. It is derived using an explicit IANA zone and is never inferred from the host or browser timezone.

With the default `Asia/Shanghai` setting, an instant at `2026-07-10T16:00:00.000Z` displays as `2026-07-11 00:00:00` and belongs to business date `2026-07-11`.

Date-only values used as aggregation keys remain `YYYY-MM-DD` strings, but their meaning is explicitly a calendar date in the active global timezone.

## Architecture

Add a small shared, framework-independent time module. It will own:

- Parsing canonical ISO instants and legacy SQLite UTC strings.
- Validating IANA timezone identifiers.
- Formatting instants in an explicit timezone with stable `zh-CN` output.
- Converting an instant to a business date key.
- Adding calendar days to a date key without depending on the process timezone.
- Converting `datetime-local` values from business-zone wall time to UTC instants and back, including daylight-saving transitions.
- Producing business-day ranges as UTC boundaries for queries.

Server and client code will import these operations instead of duplicating `new Date(value)`, timezone-offset arithmetic, or `toISOString().slice(0, 10)`.

The implementation should use built-in `Intl.DateTimeFormat` and deterministic date arithmetic unless tests expose a requirement that cannot be met reliably without a timezone library. Conversions must use the configured named IANA zone, including its daylight-saving rules, rather than a deployment-dependent local timezone.

## Global Setting

Add a persisted global `timezone` setting with default value `Asia/Shanghai`. The public settings shape exposes the active timezone and any pending rebuild status needed by the administration interface.

The administration settings interface provides a searchable selector populated from `Intl.supportedValuesOf("timeZone")` when available. A compatible fallback supplies valid common IANA zones when that API is unavailable. The server is authoritative and validates submitted identifiers by constructing `Intl.DateTimeFormat` with the requested zone.

Timezone changes use a two-phase model:

1. The requested timezone is stored as a pending target and a background aggregate rebuild is scheduled.
2. The active timezone remains unchanged while new aggregate data is built and caught up.
3. After validation, the application atomically activates the target timezone and its matching aggregate generation.
4. On failure, the old timezone and aggregates remain active; the settings interface shows the failure and offers retry.

## Display and Input Behavior

All user-facing timestamps, including logs, creation/update times, expiry times, cooldowns, snapshots, OAuth state details, and quota reset labels, will be formatted with the active global timezone.

The server-rendered placeholder behavior used to avoid hydration mismatches may remain, but server and client formatting must produce the same timezone result.

For `datetime-local` inputs:

- An entered value means wall time in the active global timezone.
- With `Asia/Shanghai`, `2026-07-11T00:00` is submitted as `2026-07-10T16:00:00.000Z`.
- Editing that stored instant restores `2026-07-11T00:00`, regardless of the user's browser timezone.
- Ambiguous or nonexistent local times around daylight-saving transitions are rejected with a validation message instead of being guessed.

Invalid timestamps continue to render as an empty value or existing fallback rather than silently becoming a different instant.

## Daily Statistics and Quotas

Every daily feature will use date keys derived in the active global timezone:

- Request and usage daily buckets.
- Admin and tenant overview charts.
- "Today" token totals and daily quota enforcement/reporting.
- Activity heatmaps and streak calculations.
- Date range defaults, previous-day navigation, and anomaly labels.

Because SQLite does not provide complete IANA timezone and daylight-saving rules, fixed SQL offsets such as `'+8 hours'` are not sufficient. Application code will calculate date keys for new records using the active timezone. Background rebuild code will calculate historical keys through the same module, ensuring live and rebuilt data use identical rules.

Rolling duration windows such as "last 24 hours", retention cutoffs, cooldown durations, and token expiry remain instant-based and must not be changed into calendar-day arithmetic.

## Migration

Introduce an idempotent database migration and aggregate-generation mechanism that:

1. Adds the active timezone, pending target, rebuild status, error, and aggregate-generation metadata.
2. Updates write paths so derived rows receive application-calculated date keys.
3. Schedules the first background rebuild from existing UTC buckets to the default `Asia/Shanghai` setting.
4. Builds a new aggregate generation from retained request logs and usage records without exposing partial results.
5. Catches up source records created during the rebuild, validates the result, and atomically switches the active generation and timezone.
6. Leaves source event timestamps and non-derived records unchanged.

Schema migration and final activation must run transactionally where supported. Background work must be resumable or safely restartable after process termination. Re-running startup after a successful migration must not rebuild the data again.

Rows generated by SQLite with `datetime('now')` are legacy UTC instants. New application writes should prefer canonical ISO UTC strings where practical, while compatibility parsing remains in place for existing rows.

Historical periods older than retained source logs cannot be reconstructed more accurately than the available source data. Derived rows will be rebuilt from all source rows that still exist.

## Error Handling

- Invalid or empty instant strings return an explicit null result from parsing helpers.
- UI formatters preserve the current `-`, `未记录`, or empty-input fallback as appropriate.
- Input conversion rejects nonexistent or malformed local date-times instead of guessing.
- Database migration or rebuild failure preserves the previous active timezone and aggregate generation.
- No behavior may depend on `process.env.TZ`, the container timezone, or the browser timezone.

## Testing

Tests will be written before production changes and cover:

- Canonical UTC ISO parsing.
- Legacy `YYYY-MM-DD HH:mm:ss` values interpreted as UTC.
- Explicit-offset timestamps normalized to the same instant.
- Display output in the configured timezone independent of the process timezone.
- `2026-07-10T15:59:59.999Z` mapping to Shanghai date `2026-07-10`.
- `2026-07-10T16:00:00.000Z` mapping to Shanghai date `2026-07-11`.
- `datetime-local` round trips at the Shanghai date boundary.
- `America/New_York` daylight-saving boundaries, including rejected nonexistent wall times.
- Server rejection of invalid IANA timezone identifiers.
- Live aggregation and background rebuild producing identical date keys.
- Migration rebuilding historical request and usage buckets into the correct business dates.
- Successful, failed, retried, and interrupted background rebuilds.
- New source rows arriving during a rebuild and appearing in the activated generation.
- "Today" totals, daily ranges, heatmap navigation, and quota reset labels.
- Invalid inputs preserving documented fallbacks.

Targeted Vitest suites, the full test suite, type checking, and linting must pass before completion.

## Scope Boundaries

This change adds one administrator-controlled global timezone, not per-user or per-tenant timezones. It does not alter external Codex timestamps or rewrite valid UTC source events. It does not change duration-based expiry, cooldown, timeout, or retention semantics. `Asia/Shanghai` is the default, while any server-validated IANA timezone can be selected.
