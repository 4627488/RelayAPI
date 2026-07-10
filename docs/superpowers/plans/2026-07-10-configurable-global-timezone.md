# Configurable Global Timezone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RelayAPI use one administrator-configured IANA timezone for all display, local date-time input, daily statistics, quotas, and historical daily aggregates, defaulting to `Asia/Shanghai`.

**Architecture:** UTC remains the storage and transport format for instants. A shared pure time module performs explicit IANA-zone conversion; a server settings service owns the active timezone; and a restart-safe background job rebuilds derived daily tables before activating a requested timezone. UI code receives the active timezone and uses shared formatting/conversion helpers rather than browser-local behavior.

**Tech Stack:** TypeScript, Next.js App Router Route Handlers, React, shadcn/ui, Drizzle ORM, better-sqlite3, Vitest, built-in `Intl` APIs.

## Global Constraints

- The default timezone is `Asia/Shanghai`.
- Accept any IANA timezone validated by `Intl.DateTimeFormat`.
- Store and transmit instants as UTC ISO 8601 strings.
- Interpret legacy timezone-less SQLite timestamps as UTC.
- Never derive application behavior from the browser, container, or process timezone.
- Keep rolling durations, expiry, cooldown, timeout, and retention calculations instant-based.
- A failed rebuild must leave the previous active timezone usable.
- Follow the repository's installed Next.js documentation and existing shadcn component patterns.

---

### Task 1: Shared IANA Time Primitives

**Files:**
- Create: `src/shared/time.ts`
- Create: `src/shared/time.test.ts`

**Interfaces:**
- Produces: `DEFAULT_TIME_ZONE`, `isValidTimeZone(value)`, `parseInstant(value)`, `formatInstant(value, timeZone)`, `instantToDateKey(value, timeZone)`, `addDateKeyDays(dateKey, days)`, `instantToLocalDateTime(value, timeZone)`, and `localDateTimeToInstant(value, timeZone)`.
- `localDateTimeToInstant` returns `{ ok: true; value: string } | { ok: false; reason: "invalid" | "ambiguous" | "nonexistent" }`.

- [ ] **Step 1: Write failing unit tests for UTC parsing and zoned date keys**

```ts
expect(parseInstant("2026-07-10 16:00:00")?.toISOString())
  .toBe("2026-07-10T16:00:00.000Z");
expect(instantToDateKey("2026-07-10T15:59:59.999Z", "Asia/Shanghai"))
  .toBe("2026-07-10");
expect(instantToDateKey("2026-07-10T16:00:00.000Z", "Asia/Shanghai"))
  .toBe("2026-07-11");
```

- [ ] **Step 2: Run `pnpm vitest run src/shared/time.test.ts` and verify failure because the module does not exist**

- [ ] **Step 3: Implement parsing, validation, formatting, date-key arithmetic, and wall-time conversion with explicit `Intl.DateTimeFormat(..., { timeZone })` calls**

```ts
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export function isValidTimeZone(value: unknown): value is string;
export function parseInstant(value: string | null | undefined): Date | null;
export function formatInstant(value: string | null | undefined, timeZone: string): string | null;
export function instantToDateKey(value: string | Date, timeZone: string): string;
export function addDateKeyDays(dateKey: string, days: number): string;
export function instantToLocalDateTime(value: string | null, timeZone: string): string;
export function localDateTimeToInstant(value: string, timeZone: string): LocalDateTimeResult;
```

- [ ] **Step 4: Add tests for invalid zones, SQLite values, explicit offsets, Shanghai round trips, and New York DST ambiguous/nonexistent times**

- [ ] **Step 5: Run `pnpm vitest run src/shared/time.test.ts` and verify all tests pass**

- [ ] **Step 6: Commit with `git commit -m "feat: add explicit timezone primitives"`**

### Task 2: Persisted Global Timezone and API Contract

**Files:**
- Modify: `src/server/services/settings.ts`
- Create: `src/server/services/settings.test.ts`
- Modify: `src/shared/types/entities.ts`
- Modify: `app/api/admin/settings/route.ts`
- Modify: `lib/admin-api.ts`

**Interfaces:**
- Produces: `getGlobalTimeZoneSetting(): string`, `requestGlobalTimeZoneChange(timeZone): GlobalSettingsRecord`, and settings fields `timeZone`, `timeZonePending`, `timeZoneRebuildStatus`, `timeZoneRebuildError`.
- PATCH accepts `{ timeZone: string }`; invalid identifiers return HTTP 400 code `invalid_time_zone`.

- [ ] **Step 1: Write failing service tests using an isolated test database**

```ts
expect(getGlobalTimeZoneSetting()).toBe("Asia/Shanghai");
expect(() => patchGlobalSettings({ timeZone: "Mars/Olympus" }))
  .toThrowError(/valid IANA timezone/);
```

- [ ] **Step 2: Run `pnpm vitest run src/server/services/settings.test.ts` and verify the new fields/functions are missing**

- [ ] **Step 3: Add setting keys and extend `GlobalSettingsRecord`**

```ts
export type TimeZoneRebuildStatus = "idle" | "pending" | "running" | "failed";
// GlobalSettingsRecord fields:
timeZone: string;
timeZonePending: string | null;
timeZoneRebuildStatus: TimeZoneRebuildStatus;
timeZoneRebuildError: string | null;
```

- [ ] **Step 4: Validate PATCH input, retain the active zone, persist pending rebuild metadata, and return the extended public settings response**

- [ ] **Step 5: Extend the client API payload/result typings and ensure the route schedules rebuild work after a timezone patch**

- [ ] **Step 6: Run the settings tests plus `pnpm exec tsc --noEmit` and verify they pass**

- [ ] **Step 7: Commit with `git commit -m "feat: add global timezone setting"`**

### Task 3: Restart-Safe Background Aggregate Rebuild

**Files:**
- Create: `src/server/services/timeZoneRebuild.ts`
- Create: `src/server/services/timeZoneRebuild.test.ts`
- Modify: `src/server/db/sqlite.ts`
- Modify: `src/server/repositories/logs.ts`
- Modify: `instrumentation.ts`

**Interfaces:**
- Consumes: `instantToDateKey`, active/pending setting keys, request logs, and usage records.
- Produces: `scheduleTimeZoneRebuild()`, `resumePendingTimeZoneRebuild()`, `getTimeZoneRebuildState()`, and application-side bucket upsert helpers.

- [ ] **Step 1: Write a failing integration test with source rows on both sides of Shanghai midnight**

```ts
await rebuildDailyAggregates("Asia/Shanghai");
expect(readRequestBucketDates()).toEqual(["2026-07-10", "2026-07-11"]);
expect(readUsageBucketDates()).toEqual(["2026-07-10", "2026-07-11"]);
```

- [ ] **Step 2: Run `pnpm vitest run src/server/services/timeZoneRebuild.test.ts` and verify failure because rebuild scheduling is absent**

- [ ] **Step 3: Add migration metadata needed to distinguish aggregate generations and remove UTC `substr(..., 1, 10)` trigger ownership from new writes**

- [ ] **Step 4: Implement rebuild into staging tables inside the log database, using `instantToDateKey` for every source timestamp**

- [ ] **Step 5: Catch up rows created after the rebuild watermark, validate aggregate totals, atomically replace active daily tables, then activate the pending timezone**

- [ ] **Step 6: Persist `running`/`failed` state, recover an interrupted job at instrumentation startup, and prevent concurrent rebuild jobs in one process**

- [ ] **Step 7: Add tests for failure preserving old buckets, retry, interruption recovery, and a row arriving during rebuild**

- [ ] **Step 8: Change live request/usage writes to upsert daily buckets with the active timezone date key and add parity tests**

- [ ] **Step 9: Run `pnpm vitest run src/server/services/timeZoneRebuild.test.ts src/server/repositories/logs.test.ts` and verify all tests pass**

- [ ] **Step 10: Commit with `git commit -m "feat: rebuild daily aggregates by configured timezone"`**

### Task 4: Business-Day Queries, Quotas, and Reset Labels

**Files:**
- Modify: `src/server/repositories/logs.ts`
- Modify: `src/server/repositories/logs.test.ts`
- Modify: `src/server/services/codexQuota.ts`
- Create or modify: `src/server/services/codexQuota.test.ts`
- Modify: `src/server/services/activityHeatmapSvg.ts`

**Interfaces:**
- Consumes: `getGlobalTimeZoneSetting`, `instantToDateKey`, and `addDateKeyDays`.
- Produces: all daily query ranges and quota labels in the active timezone.

- [ ] **Step 1: Add failing tests proving "today" changes at Shanghai 16:00 UTC and New York DST boundaries use the configured zone**

- [ ] **Step 2: Run targeted tests and verify current UTC slicing produces the wrong date**

- [ ] **Step 3: Replace `toISOString().slice(0, 10)`, UTC weekday helpers, and `substr(started_at, 1, 10)` daily query paths with business-date helpers or rebuilt bucket keys**

- [ ] **Step 4: Format Codex reset labels with the configured zone instead of `getHours()`/`getDate()`**

- [ ] **Step 5: Run repository, quota, and heatmap tests and verify they pass**

- [ ] **Step 6: Commit with `git commit -m "fix: use configured timezone for daily metrics"`**

### Task 5: Shared UI Formatting and Local Date-Time Inputs

**Files:**
- Modify: `components/workspace/format.tsx`
- Modify: `components/workspace/api-key-form.tsx`
- Modify: `components/admin-tenants-section.tsx`
- Modify: `components/admin-workbench.tsx`
- Modify: `components/admin/credentials-section.tsx`
- Modify: `components/admin/api-keys-section.tsx`
- Modify: `components/admin/proxy-pool-section.tsx`
- Modify: `components/tenant/resources-section.tsx`
- Modify: other components found by `rg "new Date\\(value\\)|parseUtcDate|toLocale|Intl.DateTimeFormat" components`
- Create: `components/workspace/format.test.tsx`

**Interfaces:**
- Consumes: active `timeZone` from loaded settings and shared pure helpers.
- Produces: one UI formatting path and timezone-explicit form conversions.

- [ ] **Step 1: Write failing tests that render the same UTC and SQLite timestamps identically under a supplied timezone**

- [ ] **Step 2: Run the formatter test and verify duplicated/browser-local code fails expectations**

- [ ] **Step 3: Make shared formatters accept a timezone and delete component-local `parseUtcDate` and `new Date(value)` formatting copies**

- [ ] **Step 4: Replace `datetimeLocalToIso` and `toDatetimeLocal` with explicit-zone helpers and surface DST validation errors in the existing form error path**

- [ ] **Step 5: Propagate the active timezone through admin and tenant workbench props without importing server-only settings into client components**

- [ ] **Step 6: Run formatter tests, component tests, and `pnpm exec tsc --noEmit`**

- [ ] **Step 7: Commit with `git commit -m "fix: render and edit times in global timezone"`**

### Task 6: Global Settings Timezone Selector and Rebuild Status

**Files:**
- Modify: `components/admin-workbench.tsx`
- Use existing: `components/ui/select.tsx`, `components/ui/field.tsx`, `components/ui/alert.tsx`, `components/ui/spinner.tsx`
- Modify: `lib/admin-api.ts`

**Interfaces:**
- Consumes: settings timezone/status fields and PATCH API.
- Produces: searchable IANA selection, save action, running/failed status, and retry action.

- [ ] **Step 1: Run `pnpm dlx shadcn@latest info --json` and `pnpm dlx shadcn@latest docs select field alert spinner` before editing component composition**

- [ ] **Step 2: Add a failing component test for selecting a zone, pending status, and failed retry state**

- [ ] **Step 3: Build the timezone field with existing shadcn form primitives, sourcing zones from `Intl.supportedValuesOf("timeZone")` with a compatible fallback**

- [ ] **Step 4: PATCH the selected timezone, poll settings while status is pending/running, and show an Alert for failure without changing the displayed active zone**

- [ ] **Step 5: Add copy explaining that daily statistics are rebuilt in the background and the previous timezone remains active until completion**

- [ ] **Step 6: Run component tests, lint the modified UI, and verify TypeScript**

- [ ] **Step 7: Commit with `git commit -m "feat: configure timezone from global settings"`**

### Task 7: Full Migration and Regression Verification

**Files:**
- Modify as required by failures: only files already listed above
- Update: `README.md`

**Interfaces:**
- Produces: documented timezone behavior and a verified release-ready change.

- [ ] **Step 1: Add an upgrade integration test starting from legacy UTC buckets and timezone-less SQLite timestamps**

- [ ] **Step 2: Run the migration test and verify it rebuilds into `Asia/Shanghai` without altering source instant strings**

- [ ] **Step 3: Document the default, administrator setting, background rebuild behavior, and UTC storage contract in README**

- [ ] **Step 4: Run `pnpm test` and require zero failures**

- [ ] **Step 5: Run `pnpm exec tsc --noEmit` and require zero errors**

- [ ] **Step 6: Run `pnpm lint` and require zero errors**

- [ ] **Step 7: Run `pnpm build` and require a successful production build**

- [ ] **Step 8: Inspect `git diff --check` and `git status --short`, confirming only intended files remain**

- [ ] **Step 9: Commit with `git commit -m "docs: document configurable application timezone"`**
