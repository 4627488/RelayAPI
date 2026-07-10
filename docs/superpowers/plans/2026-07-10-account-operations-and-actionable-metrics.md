# Account Operations and Actionable Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure tenant and administrator password operations, configurable public-link construction, session revocation, account activity, and replace low-value overview metrics.

**Architecture:** Extend the existing SQLite tenant-user and invite patterns with password-reset records and session versions. Keep validation and token lifecycle in services, expose small Route Handlers, then add typed client operations and focused dialogs/forms. Metric changes remain presentation-only over existing overview aggregates.

**Tech Stack:** Next.js 16.2 App Router, React 19.2, TypeScript, Drizzle SQLite, shadcn Base UI, Vitest.

## Global Constraints

- Never persist or log raw passwords, reset tokens, cookies, or password hashes.
- Reset links expire after one hour and are single-use.
- Passwords require at least 10 characters.
- Public links use configured `publicBaseUrl`, otherwise the administrator browser origin.
- Backend API relay contracts remain unchanged.

---

### Task 1: Account persistence and session versions

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/sqlite.ts`
- Modify: `src/server/repositories/tenants.ts`
- Modify: `src/shared/types/entities.ts`
- Test: `src/server/services/tenants.test.ts`

**Interfaces:** Produces reset-token persistence, `sessionVersion`, `lastLoginAt`, `passwordChangedAt`, password-hash updates, and version increments.

- [ ] Write tests proving a new reset token replaces an older token and session version increments.
- [ ] Run `pnpm vitest run src/server/services/tenants.test.ts` and observe the missing behavior failure.
- [ ] Add migration `010_tenant_account_operations`, schema fields, repository functions, and public account timestamps.
- [ ] Rerun the focused test and commit with `feat: add tenant account persistence`.

### Task 2: Password services and APIs

**Files:**
- Modify: `src/server/services/tenants.ts`
- Modify: `src/server/services/webAccess.ts`
- Modify: `src/server/services/settings.ts`
- Modify: `app/api/admin/settings/route.ts`
- Create: `app/api/admin/tenants/[id]/password-reset/route.ts`
- Create: `app/api/admin/tenants/[id]/sessions/route.ts`
- Create: `app/api/tenant/auth/password/route.ts`
- Create: `app/api/tenant/auth/reset-password/route.ts`
- Test: `src/server/services/tenants.test.ts`
- Test: `src/server/services/settings.test.ts`

**Interfaces:** Produces `createTenantPasswordReset`, `completeTenantPasswordReset`, `changeTenantPassword`, `revokeTenantSessions`, normalized `publicBaseUrl`, and refreshed session cookies.

- [ ] Write failing tests for expiry, single use, password validation, version enforcement, and URL normalization.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement service operations and Route Handlers with uniform invalid-token errors.
- [ ] Rerun focused tests and commit with `feat: add password and session operations`.

### Task 3: Administrator and tenant account UI

**Files:**
- Modify: `lib/admin-api.ts`
- Modify: `lib/tenant-api.ts`
- Modify: `components/admin-tenants-section.tsx`
- Modify: `components/admin-workbench.tsx`
- Modify: `components/tenant/settings-section.tsx`
- Create: `app/tenant/reset-password/page.tsx`
- Create: `components/auth/tenant-reset-password.tsx`

**Interfaces:** Produces reset-link copy dialog, force-sign-out action, self-service password form, administrator password form, public-site setting, and reset page.

- [ ] Add source-contract tests for required endpoints and form labels, then observe failure.
- [ ] Implement typed client calls and UI using existing Dialog, Field, Input, Button, Alert, and toast patterns.
- [ ] Run focused tests and ESLint for all touched UI files.
- [ ] Commit with `feat: add account security controls`.

### Task 4: Actionable overview metrics

**Files:**
- Modify: `components/admin-workbench.tsx`
- Modify: `components/tenant/overview-section.tsx`
- Test: `src/shared/workspace-shell-source.test.ts`

**Interfaces:** Replaces inventory and active-key headlines with reliability, P95 latency, remaining quota, failures, and per-request efficiency.

- [ ] Write source-contract assertions rejecting `活跃 Key` and requiring `P95 首 Token` and `剩余额度`.
- [ ] Observe the focused test fail.
- [ ] Recompose both metric strips using existing overview aggregates and quota limits.
- [ ] Run focused tests, `pnpm test`, `pnpm lint`, and `pnpm build`.
- [ ] Commit with `feat: surface actionable operations metrics`.
