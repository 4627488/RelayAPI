# Frontend Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current RelayAPI frontend with a dense technical workbench for admin and tenant operators.

**Architecture:** Keep existing routes and API helpers, but replace presentation-heavy shells with shared workbench primitives. Move repeated formatting, API key form helpers, quota lines, and request log UI into shared workspace components, then recompose admin and tenant consoles around compact navigation, command bars, metric strips, tables, and sheets.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4, shadcn base components, lucide-react, Recharts.

---

## File Structure

- Create `components/workspace/format.tsx`: shared formatting helpers.
- Create `components/workspace/status-badge.tsx`: compact status badge abstraction.
- Create `components/workspace/metric-strip.tsx`: dense metric row.
- Create `components/workspace/data-panel.tsx`: compact panel shell.
- Create `components/workspace/section-toolbar.tsx`: shared toolbar shell.
- Create `components/workspace/detail-sheet.tsx`: reusable sheet wrapper.
- Create `components/workspace/workspace-shell.tsx`: new admin/tenant shell with rail navigation and command bar.
- Create `components/admin-workbench.tsx`: admin console with workbench naming, compact overview/settings rendering, and direct `WorkspaceShell` usage.
- Create `components/tenant-workbench.tsx`: tenant console with concise tenant navigation and direct `WorkspaceShell` usage.
- Delete old dashboard shell and helper files after migration.
- Create `components/workspace/request-logs-workbench.tsx`: shared request log table/detail implementation.
- Modify `components/admin/logs-section.tsx`: wrap shared log workbench for admin API functions.
- Modify `components/tenant/logs-section.tsx`: wrap shared log workbench for tenant API functions.
- Modify oversized section files as needed to use shared format/status/panel primitives without changing backend contracts.

## Task 1: Shared Formatting And Status Primitives

**Files:**
- Create: `components/workspace/format.tsx`
- Create: `components/workspace/status-badge.tsx`
- Create: `components/workspace/metric-strip.tsx`

- [ ] **Step 1: Create shared formatting helpers**

Use duplicated helpers from log/overview sections as the source. Export:

```tsx
export function formatNumber(value: number): string
export function formatCompactNumber(value: number): string
export function formatTokenNumber(value: number): string
export function formatDuration(value: number): string
export function formatNullableDuration(value: number | null | undefined): string
export function formatPercent(value: number | null | undefined): string
export function formatDateTime(value: string | null | undefined): string
export function formatNullableDate(value: string | null | undefined): React.ReactNode
export function renderBadgeList(values: string[], empty: string): React.ReactNode
```

- [ ] **Step 2: Create compact status badge**

Implement `WorkspaceStatusBadge` with semantic variants:

```tsx
type WorkspaceStatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "muted";
```

Map tones to existing `Badge` variants and semantic class names. Keep labels short.

- [ ] **Step 3: Create metric strip**

Implement `MetricStrip` and `MetricStripItem` for compact horizontal summaries. It should use tabular numbers and wrap on small screens.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`

Expected: no new lint errors from the created primitives.

## Task 2: Workbench Layout Primitives

**Files:**
- Create: `components/workspace/data-panel.tsx`
- Create: `components/workspace/section-toolbar.tsx`
- Create: `components/workspace/detail-sheet.tsx`
- Create: `components/workspace/workspace-shell.tsx`

- [ ] **Step 1: Create `DataPanel`**

Build a compact wrapper around shadcn `Card` with optional title, action slot, and flush content mode. Avoid descriptive paragraphs by default.

- [ ] **Step 2: Create `SectionToolbar`**

Build a toolbar with left, center, and right slots. It must wrap cleanly on mobile and use `gap-*`, not `space-*`.

- [ ] **Step 3: Create `WorkbenchDetailSheet`**

Wrap shadcn `Sheet` with required title and optional description. Use it for details, not forms.

- [ ] **Step 4: Create `WorkspaceShell`**

Implement left rail navigation, top command bar, summary slot, action slot, and content area. It replaces the current large dashboard header with compact operator UI.

- [ ] **Step 5: Run lint**

Run: `pnpm lint`

Expected: no lint errors from new layout primitives.

## Task 3: Admin And Tenant Shell Migration

**Files:**
- Create/modify: `components/admin-workbench.tsx`
- Create/modify: `components/tenant-workbench.tsx`
- Delete: `components/dashboard-chrome.tsx`
- Delete/move: `components/dashboard/*`

- [ ] **Step 1: Rename navigation labels to workbench domains**

Admin labels become `Overview`, `Traffic`, `Routing`, `Access`, `Settings` while preserving internal section ids where minimizing churn is useful. Tenant labels become `Overview`, `Keys`, `Setup`, `Traffic`, `Resources`, `Settings`.

- [ ] **Step 2: Remove long shell descriptions**

Replace paragraph descriptions with short operational labels or omit them. Keep status and snapshot visible.

- [ ] **Step 3: Compact summary slots**

Use `MetricStrip`/summary rows instead of prose. Keep values scan-friendly.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`

Expected: workbench shell compiles without lint errors.

## Task 4: Shared Request Logs Workbench

**Files:**
- Create: `components/workspace/request-logs-workbench.tsx`
- Modify: `components/admin/logs-section.tsx`
- Modify: `components/tenant/logs-section.tsx`

- [ ] **Step 1: Extract common request log props**

Define props for:

```tsx
type RequestLogsWorkbenchProps = {
  initialPage: RequestLogsPage;
  loadPage: (options: {
    limit?: number;
    page?: number;
    query?: string;
    status?: RequestLogStatusFilter;
  }) => Promise<RequestLogsPage>;
  loadDetail: (id: string) => Promise<RequestLogDetail>;
  onLoaded?: (page: RequestLogsPage) => void;
  pruneAction?: React.ReactNode;
};
```

- [ ] **Step 2: Move common table/search/detail code**

Move shared code from admin and tenant log sections into `RequestLogsWorkbench`. Keep admin-only prune as an optional action slot.

- [ ] **Step 3: Replace admin logs with wrapper**

`components/admin/logs-section.tsx` should pass admin API functions and prune controls into the shared workbench.

- [ ] **Step 4: Replace tenant logs with wrapper**

`components/tenant/logs-section.tsx` should pass tenant API functions into the shared workbench.

- [ ] **Step 5: Run lint**

Run: `pnpm lint`

Expected: both log sections compile and no duplicated imported helpers remain unused.

## Task 5: Compact Existing Sections

**Files:**
- Modify: `components/admin/api-keys-section.tsx`
- Modify: `components/admin/channels-section.tsx`
- Modify: `components/admin/credentials-section.tsx`
- Modify: `components/admin/proxy-pool-section.tsx`
- Modify: `components/admin-tenants-section.tsx`
- Modify: `components/tenant/overview-section.tsx`
- Modify: `components/tenant/resources-section.tsx`
- Modify: `components/tenant/codex-setup-section.tsx`
- Modify: `components/tenant/settings-section.tsx`

- [ ] **Step 1: Replace repeated cards with `DataPanel`**

Use `DataPanel` for section wrappers where a card is still appropriate. Avoid nested card layouts.

- [ ] **Step 2: Replace repeated formatting helpers**

Import from `components/workspace/format.tsx` and delete local duplicates when safe.

- [ ] **Step 3: Replace status spans with `WorkspaceStatusBadge`**

Use badge tones consistently for enabled, disabled, healthy, degraded, error, quota, and cooldown states.

- [ ] **Step 4: Remove explanatory copy**

Delete long descriptions that explain obvious UI behavior. Keep labels required for forms, warnings, and accessibility.

- [ ] **Step 5: Run lint**

Run: `pnpm lint`

Expected: no unused imports and no syntax errors.

## Task 6: Final Verification

**Files:**
- Modify as needed based on verification failures.

- [ ] **Step 1: Run lint**

Run: `pnpm lint`

Expected: pass.

- [ ] **Step 2: Run production build**

Run: `pnpm build`

Expected: pass.

- [ ] **Step 3: Start dev server**

Run: `pnpm dev`

Expected: local server starts.

- [ ] **Step 4: Manual smoke**

Open the local URL and verify:

- admin login screen is concise,
- admin workbench shell renders,
- tenant workbench shell renders when session exists,
- section navigation does not break layout,
- log detail sheet opens,
- create/edit dialogs still open.

- [ ] **Step 5: Inspect changed files**

Run: `git diff --stat` and `git diff --check`

Expected: no whitespace errors and changes match the redesign scope.
