# RelayAPI High-Density Operations Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the administrator and tenant interfaces into a coherent, high-density operations console where health, exceptions, comparisons, and actions are easier to understand than the current card-heavy workbench.

**Architecture:** Keep the existing Server Component pages, client-side data orchestration, API contracts, and shadcn Base UI components. Replace the shared shell and presentation primitives first, then simplify the two overview surfaces and normalize resource/log layouts around the new primitives. Presentation calculations that affect labels or visibility remain pure functions and receive focused Vitest coverage.

**Tech Stack:** Next.js 16.2 App Router, React 19.2, TypeScript 5, Tailwind CSS 4, shadcn Base Nova/Base UI, Lucide, Recharts, Vitest.

## Global Constraints

- Do not change backend API contracts or authentication behavior.
- Do not add a state-management or visualization library.
- Use semantic design tokens and the installed shadcn components.
- Keep administrator and tenant information architectures distinct.
- Remove decorative copy, redundant summaries, and charts that do not answer an operational question.
- Preserve keyboard focus, mobile navigation, loading, empty, error, and confirmation behavior.

---

### Task 1: Shared Console Grammar

**Files:**
- Modify: `app/globals.css`
- Modify: `components/workspace/workspace-shell.tsx`
- Modify: `components/workspace/metric-strip.tsx`
- Modify: `components/workspace/data-panel.tsx`
- Modify: `components/workspace/section-toolbar.tsx`
- Create: `components/workspace/workspace-shell.test.tsx`

**Interfaces:**
- Consumes: existing shadcn `Button`, `Badge`, `Separator`, `Sheet`, and semantic CSS variables.
- Produces: grouped `WorkspaceNavItem` support through optional `group?: string`; a shell without `eyebrow`, `snapshot`, or `summary`; compact continuous `MetricStrip`, `DataPanel`, and `SectionToolbar` primitives.

- [ ] **Step 1: Write the failing shell contract test**

```tsx
expect(source).toContain("group?: string")
expect(source).not.toContain("eyebrow:")
expect(source).not.toContain("snapshot:")
expect(source).toContain("aria-label=\"主导航\"")
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run components/workspace/workspace-shell.test.tsx`
Expected: FAIL because the legacy shell still requires eyebrow and snapshot content.

- [ ] **Step 3: Implement the shared visual grammar**

Introduce grouped navigation, a compact product mark, active-item rail treatment, a simple page header, mobile sheet navigation, border-separated metrics, and continuous data panels. Add global selection, scrollbar, body, and numeric rendering refinements using semantic tokens only.

- [ ] **Step 4: Run the focused test and type-aware lint**

Run: `pnpm vitest run components/workspace/workspace-shell.test.tsx && pnpm eslint app/globals.css components/workspace/workspace-shell.tsx components/workspace/metric-strip.tsx components/workspace/data-panel.tsx components/workspace/section-toolbar.tsx`
Expected: PASS with no ESLint errors.

- [ ] **Step 5: Commit the shared grammar**

```bash
git add app/globals.css components/workspace
git commit -m "feat: establish operations console visual grammar"
```

### Task 2: Administrator Navigation and Operations Overview

**Files:**
- Modify: `components/admin-workbench.tsx`
- Modify: `components/admin/api-keys-section.tsx`
- Modify: `components/admin/channels-section.tsx`
- Modify: `components/admin/credentials-section.tsx`
- Modify: `components/admin/proxy-pool-section.tsx`
- Modify: `components/admin-tenants-section.tsx`
- Create: `components/admin/admin-overview-presenter.ts`
- Create: `components/admin/admin-overview-presenter.test.ts`

**Interfaces:**
- Consumes: `AdminOverviewStats`, existing resource counts, existing section callbacks, and Task 1 shell primitives.
- Produces: `getAdminAttentionItems(stats, resourceCounts)` and `getAdminHeadlineMetrics(stats)` pure presenters; grouped Monitor, Route, Access, and System navigation.

- [ ] **Step 1: Write failing presenter tests**

```ts
expect(getAdminAttentionItems(healthyStats, healthyCounts)).toEqual([])
expect(getAdminAttentionItems(errorStats, healthyCounts)[0]?.tone).toBe("danger")
expect(getAdminHeadlineMetrics(stats).map((item) => item.label)).toEqual([
  "请求", "错误率", "P95 延迟", "Token",
])
```

- [ ] **Step 2: Run the presenter tests and verify failure**

Run: `pnpm vitest run components/admin/admin-overview-presenter.test.ts`
Expected: FAIL because the presenter module does not exist.

- [ ] **Step 3: Implement the administrator console**

Replace legacy navigation copy and shell props. Recompose the overview around four headline metrics, one request/error trend, an attention queue, and routing health. Remove permanent ranking and matrix panels from the first screen. Normalize section headers and resource tables so actions and state lead while descriptions and decorative badges recede.

- [ ] **Step 4: Verify administrator tests and lint**

Run: `pnpm vitest run components/admin/admin-overview-presenter.test.ts && pnpm eslint components/admin-workbench.tsx components/admin components/admin-tenants-section.tsx`
Expected: PASS with no ESLint errors.

- [ ] **Step 5: Commit administrator redesign**

```bash
git add components/admin-workbench.tsx components/admin components/admin-tenants-section.tsx
git commit -m "feat: redesign administrator operations console"
```

### Task 3: Tenant Usage, Access, and Connection Surfaces

**Files:**
- Modify: `components/tenant-workbench.tsx`
- Modify: `components/tenant/overview-section.tsx`
- Modify: `components/tenant/api-keys-section.tsx`
- Modify: `components/tenant/codex-setup-section.tsx`
- Modify: `components/tenant/resources-section.tsx`
- Modify: `components/tenant/settings-section.tsx`
- Create: `components/tenant/tenant-overview-presenter.ts`
- Create: `components/tenant/tenant-overview-presenter.test.ts`

**Interfaces:**
- Consumes: `AdminOverviewStats`, tenant limits, API-key usage data, and Task 1 shell primitives.
- Produces: `getTenantHeadlineMetrics(stats, tenant)` and `getTenantQuotaState(stats, tenant)` pure presenters; grouped Usage, Access, Connect, Diagnose, and Configure navigation.

- [ ] **Step 1: Write failing tenant presenter tests**

```ts
expect(getTenantQuotaState(stats, unlimitedTenant).kind).toBe("unlimited")
expect(getTenantQuotaState(stats, limitedTenant).percent).toBe(75)
expect(getTenantHeadlineMetrics(stats, tenant)).toHaveLength(4)
```

- [ ] **Step 2: Run the presenter tests and verify failure**

Run: `pnpm vitest run components/tenant/tenant-overview-presenter.test.ts`
Expected: FAIL because the presenter module does not exist.

- [ ] **Step 3: Implement the tenant console**

Remove inherited administrator language and legacy shell summaries. Keep consumption, remaining allowance, reliability, and latency as the first-level story; retain one trend and one key-comparison table. Remove the default cache pie and redundant spend table. Make key creation and recommended Codex configuration the obvious actions, with advanced controls visually secondary.

- [ ] **Step 4: Verify tenant tests and lint**

Run: `pnpm vitest run components/tenant/tenant-overview-presenter.test.ts && pnpm eslint components/tenant-workbench.tsx components/tenant`
Expected: PASS with no ESLint errors.

- [ ] **Step 5: Commit tenant redesign**

```bash
git add components/tenant-workbench.tsx components/tenant
git commit -m "feat: redesign tenant operations console"
```

### Task 4: Shared Request Diagnostics Density

**Files:**
- Modify: `components/workspace/request-logs-workbench.tsx`
- Modify: `components/workspace/detail-sheet.tsx`
- Test: `src/shared/workspace-format.test.ts`

**Interfaces:**
- Consumes: existing request log pagination, filters, formatting, and detail API callbacks.
- Produces: a sticky compact diagnostics toolbar, scan-optimized table, and structured detail sheet without changing request-log props or API behavior.

- [ ] **Step 1: Extend formatting assertions for compact diagnostics**

```ts
expect(formatDuration(999)).toBe("999ms")
expect(formatDuration(1200)).toBe("1.2s")
expect(formatNullable(null)).toBe("—")
```

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/shared/workspace-format.test.ts`
Expected: PASS for preserved format behavior before presentation changes.

- [ ] **Step 3: Recompose the diagnostics surface**

Reduce the metric strip to operational filters and totals that affect inspection, make the filter row sticky within the work surface, tighten table columns, preserve status and latency scanning, and organize the detail sheet into request, upstream, timing, and error groups.

- [ ] **Step 4: Run tests and lint**

Run: `pnpm vitest run src/shared/workspace-format.test.ts && pnpm eslint components/workspace/request-logs-workbench.tsx components/workspace/detail-sheet.tsx`
Expected: PASS with no ESLint errors.

- [ ] **Step 5: Commit diagnostics redesign**

```bash
git add components/workspace/request-logs-workbench.tsx components/workspace/detail-sheet.tsx src/shared/workspace-format.test.ts
git commit -m "feat: sharpen request diagnostics workspace"
```

### Task 5: Whole-Application Verification and Cleanup

**Files:**
- Modify: only files implicated by verification failures.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a buildable, lint-clean, tested operations console.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all Vitest suites pass.

- [ ] **Step 2: Run repository lint**

Run: `pnpm lint`
Expected: ESLint exits 0.

- [ ] **Step 3: Run the production build**

Run: `pnpm build`
Expected: Next.js production compilation and static checks complete successfully.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and only intentional redesign files remain.

- [ ] **Step 5: Commit verification fixes if needed**

```bash
git add <files-fixed-during-verification>
git commit -m "fix: finish operations console verification"
```
