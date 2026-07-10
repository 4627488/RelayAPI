# Tenant Share Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce independent, price-weighted 5-hour and 7-day quota windows for tenants using share-based capacity inferred from upstream Codex quota movement.

**Architecture:** A focused accounting service resolves immutable model prices, calibrates a per-share baseline, and atomically reserves and settles tenant capacity in the main SQLite database. The relay invokes that service before and after upstream work, while the log database stores immutable cost facts for administrative and tenant analysis.

**Tech Stack:** Next.js 16.2 route handlers, React 19, TypeScript, better-sqlite3, Drizzle schema declarations, Vitest, shadcn/ui, Recharts.

## Global Constraints

- Tenant is the accounting principal; all tenant API keys and sessions share both windows.
- Plus is one plan share and Pro is twenty plan shares by default.
- Prices are immutable per request and use integer nano-dollars.
- Price precedence is administrator override, cached LiteLLM catalog, bundled fallback.
- Unknown prices never become zero-cost traffic for an enforced tenant.
- Existing daily token and per-minute limits remain independent policies.
- Read relevant files in `node_modules/next/dist/docs/` before changing Next.js route handlers.

---

### Task 1: Pricing domain and catalog

**Files:**
- Create: `src/server/services/modelPricing.ts`
- Create: `src/server/services/modelPricing.test.ts`
- Create: `src/server/pricing/litellm-fallback.json`
- Modify: `src/shared/types/entities.ts`

**Interfaces:**
- Produces: `resolveModelPrice(model: string): ModelPriceSnapshot | null`
- Produces: `calculateRequestCost(price: ModelPriceSnapshot, usage: PricedUsageSnapshot): RequestCostBreakdown`
- Produces: `normalizeLiteLlmCatalog(payload: unknown): NormalizedModelPrice[]`

- [ ] **Step 1: Write failing tests for alias resolution, override precedence, cache subtraction, component pricing, and unknown models**

```ts
expect(calculateRequestCost(price, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, cacheWriteTokens: 0, reasoningTokens: 2 }).totalNanoUsd).toBe(1_290n);
expect(resolveModelPrice("missing-model")).toBeNull();
```

- [ ] **Step 2: Run `pnpm test -- src/server/services/modelPricing.test.ts` and verify failures identify missing exports**
- [ ] **Step 3: Implement strict catalog parsing, model aliases, immutable snapshots, and bigint cost arithmetic**
- [ ] **Step 4: Add a minimal bundled catalog covering currently exposed relay models and validate it during module load**
- [ ] **Step 5: Run the focused test and `pnpm lint src/server/services/modelPricing.ts src/server/services/modelPricing.test.ts`**
- [ ] **Step 6: Commit with `feat: add model-aware request pricing`**

### Task 2: Accounting schema and repositories

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/sqlite.ts`
- Modify: `src/server/repositories/tenants.ts`
- Create: `src/server/repositories/quotaAccounting.ts`
- Create: `src/server/repositories/quotaAccounting.test.ts`
- Modify: `src/shared/types/entities.ts`

**Interfaces:**
- Produces: `getEffectiveQuotaBaseline(window: QuotaWindowKind): EffectiveQuotaBaseline`
- Produces: `reserveTenantQuota(input: ReserveTenantQuotaInput): TenantQuotaReservation`
- Produces: `settleTenantQuota(input: SettleTenantQuotaInput): TenantQuotaState`
- Produces: `releaseTenantQuota(requestId: string): void`
- Produces: `getTenantQuotaState(tenantId: string): TenantQuotaState`

- [ ] **Step 1: Write migration/repository tests that open a temporary database and assert tenant shares, pricing tables, baselines, window rows, and reservations persist**
- [ ] **Step 2: Add concurrency tests asserting two reservations cannot both consume the same last capacity and settlement is idempotent by request ID**
- [ ] **Step 3: Run `pnpm test -- src/server/repositories/quotaAccounting.test.ts` and verify schema/API failures**
- [ ] **Step 4: Add additive migrations and matching Drizzle declarations; store decimal shares as integer milli-shares and monetary values as decimal strings representing bigint nano-dollars**
- [ ] **Step 5: Implement immediate-transaction reservation, fixed-window rollover, expired-reservation reclamation, settlement, release, and state reads**
- [ ] **Step 6: Extend tenant mapping and validation so `quotaShares` is null or a positive decimal up to three places**
- [ ] **Step 7: Run repository and tenant tests, then commit `feat: persist tenant quota accounting`**

### Task 3: Dynamic capacity calibration

**Files:**
- Create: `src/server/services/quotaCalibration.ts`
- Create: `src/server/services/quotaCalibration.test.ts`
- Modify: `src/server/repositories/quotaAccounting.ts`
- Modify: `src/server/services/codexQuota.ts`
- Modify: `src/server/services/codexQuota.test.ts`

**Interfaces:**
- Produces: `recordQuotaObservation(input: QuotaObservationInput): CalibrationResult[]`
- Produces: `recomputeQuotaBaseline(window: QuotaWindowKind): EffectiveQuotaBaseline`
- Consumes: credential-attributed priced cost totals from Task 2.

- [ ] **Step 1: Write failing tests for valid percentage deltas, reset changes, decreases, minimum delta, Plus/Pro share normalization, unpriced gaps, weighted median, MAD filtering, and manual overrides**
- [ ] **Step 2: Run focused calibration tests and verify they fail on missing behavior**
- [ ] **Step 3: Implement observation pairing and accepted/rejected sample records with explicit reason codes**
- [ ] **Step 4: Implement weighted median, outlier filtering, confidence scoring, staleness, plan-share mapping, and effective override selection**
- [ ] **Step 5: Call observation recording only after a successful fresh WHAM quota response; preserve existing cached response semantics**
- [ ] **Step 6: Run Codex quota and calibration tests, then commit `feat: infer quota capacity from upstream usage`**

### Task 4: Tenant quota service and errors

**Files:**
- Create: `src/server/services/tenantQuota.ts`
- Create: `src/server/services/tenantQuota.test.ts`
- Modify: `src/server/http/errors.ts`
- Modify: `src/server/codex/errors.ts`
- Modify: `src/shared/types/entities.ts`

**Interfaces:**
- Produces: `admitTenantRequest(input: AdmitTenantRequestInput): TenantQuotaAdmission | null`
- Produces: `settleTenantRequest(input: SettleTenantRequestInput): TenantQuotaState | null`
- Produces: `releaseTenantRequest(requestId: string): void`
- Produces: `tenantQuotaHeaders(state: TenantQuotaState): HeadersInit`

- [ ] **Step 1: Write tests for disabled quota, missing price, unhealthy baseline, both window failures, reservation estimates, quota headers, Retry-After, and Codex-compatible 429 bodies**
- [ ] **Step 2: Run the focused test and verify missing service failures**
- [ ] **Step 3: Implement recent-model reservation estimates with a conservative configured fallback and hard bounds**
- [ ] **Step 4: Implement admission, error mapping, settlement/release wrappers, and stable `x-relay-quota-*` response headers**
- [ ] **Step 5: Run focused tests and commit `feat: enforce tenant share quota policies`**

### Task 5: Usage extraction and relay integration

**Files:**
- Modify: `src/shared/types/entities.ts`
- Modify: `src/server/codex/sse.ts`
- Modify: `src/server/codex/sse.test.ts`
- Modify: `src/server/http/relay.ts`
- Create: `src/server/http/relay.quota.test.ts`
- Modify: `src/server/repositories/logs.ts`
- Modify: `src/server/repositories/logs.test.ts`

**Interfaces:**
- Consumes: Task 4 admission/settlement API.
- Produces: enriched `UsageSnapshot` including cached input, cache write, and reasoning tokens when upstream reports them.

- [ ] **Step 1: Write failing JSON and SSE tests that extract all usage categories and preserve existing token totals**
- [ ] **Step 2: Write relay tests proving rejection occurs before upstream fetch, successful streams settle once, early failures release, partial usage settles, and quota headers are returned**
- [ ] **Step 3: Run focused tests and verify failures**
- [ ] **Step 4: Extend usage parsing and logging types without changing public OpenAI/Codex payloads**
- [ ] **Step 5: Integrate pricing and admission after model/channel context is known but before upstream dispatch; wrap all terminal paths in idempotent settlement or release**
- [ ] **Step 6: Add immutable pricing/cost columns to log migrations and records, and populate them through the existing write queue**
- [ ] **Step 7: Run relay, SSE, log queue, and repository tests; commit `feat: account for priced relay usage`**

### Task 6: Pricing and quota administration APIs

**Files:**
- Create: `src/server/services/quotaAdministration.ts`
- Create: `src/server/services/quotaAdministration.test.ts`
- Create: `app/api/admin/quota/route.ts`
- Create: `app/api/admin/quota/pricing/route.ts`
- Create: `app/api/admin/quota/pricing/refresh/route.ts`
- Create: `app/api/admin/quota/calibration/route.ts`
- Modify: `app/api/admin/tenants/[id]/route.ts`
- Modify: `lib/admin-api.ts`

**Interfaces:**
- Produces authenticated GET/PATCH APIs for baselines, overrides, plan shares, catalog state, model overrides/aliases, calibration samples, and tenant shares.

- [ ] **Step 1: Re-read the local Next.js route-handler guide and follow promised `params` semantics**
- [ ] **Step 2: Write service tests for payload validation, remote catalog validation/activation, override deletion, and sanitized sample output**
- [ ] **Step 3: Implement remote LiteLLM refresh with timeout, size limit, schema validation, version hashing, atomic activation, and audit logging**
- [ ] **Step 4: Implement authenticated route handlers using existing admin error/CORS conventions**
- [ ] **Step 5: Add typed admin client functions and run service/API type tests**
- [ ] **Step 6: Commit `feat: add quota administration APIs`**

### Task 7: Tenant quota and cost analysis APIs

**Files:**
- Create: `app/api/tenant/quota/route.ts`
- Create: `app/api/admin/cost-analysis/route.ts`
- Create: `app/api/tenant/cost-analysis/route.ts`
- Modify: `src/server/repositories/logs.ts`
- Modify: `src/server/repositories/logs.test.ts`
- Modify: `lib/admin-api.ts`
- Modify: `lib/tenant-api.ts`

**Interfaces:**
- Produces `TenantQuotaState` and model/category/time cost analysis while enforcing tenant scope.

- [ ] **Step 1: Write repository tests for model/category aggregation, price completeness, date filters, and strict tenant isolation**
- [ ] **Step 2: Run focused tests and verify missing query failures**
- [ ] **Step 3: Implement cost analysis queries over immutable logged costs and tenant quota state reads**
- [ ] **Step 4: Add authenticated route handlers and typed clients; admin accepts tenant filters, tenant route derives tenant only from session**
- [ ] **Step 5: Run tests and commit `feat: expose quota cost analysis`**

### Task 8: Administrator and tenant interfaces

**Files:**
- Create: `components/admin/quota-section.tsx`
- Create: `components/tenant/quota-section.tsx`
- Modify: `components/admin-tenants-section.tsx`
- Modify: `components/admin-workbench.tsx`
- Modify: `components/tenant-workbench.tsx`
- Modify: `components/tenant/overview-section.tsx`
- Modify: `components/workspace/limit-line.tsx`
- Modify: `src/shared/workspace-shell-source.test.ts`

**Interfaces:**
- Consumes typed API functions from Tasks 6 and 7.

- [ ] **Step 1: Read the shadcn skill and query the local registry documentation for existing Card, Progress, Table, Tabs, Input, and Alert components**
- [ ] **Step 2: Add source/component tests for labels, tenant isolation, share entry, both reset countdowns, pricing health, override controls, and cost breakdowns**
- [ ] **Step 3: Extend the tenant editor with nullable share input and a compact live 5h/7d summary**
- [ ] **Step 4: Build the admin quota section with baseline health, catalog refresh, overrides, missing model alerts, calibration sample table, and cost analysis filters**
- [ ] **Step 5: Build the tenant quota section and overview meters without exposing credential identities or other tenant data**
- [ ] **Step 6: Run component/source tests and lint; commit `feat: add quota operations interfaces`**

### Task 9: Scheduler, recovery, and compatibility

**Files:**
- Modify: `instrumentation.ts`
- Create: `src/server/services/quotaMaintenance.ts`
- Create: `src/server/services/quotaMaintenance.test.ts`
- Modify: `src/server/config/env.ts`
- Modify: `README.md`

**Interfaces:**
- Produces idempotent scheduled price refresh, stale reservation reclamation, and calibration freshness maintenance.

- [ ] **Step 1: Write tests for single-flight maintenance, expired reservation cleanup, failed refresh preserving active catalog, and clean shutdown**
- [ ] **Step 2: Implement bounded maintenance intervals with environment configuration and server-only startup registration**
- [ ] **Step 3: Document quota semantics, price precedence, headers, errors, defaults, and operational recovery**
- [ ] **Step 4: Run maintenance tests and commit `feat: maintain quota pricing and reservations`**

### Task 10: Full verification and review

**Files:**
- Modify only files required to fix verification findings.

- [ ] **Step 1: Run `pnpm test` and retain the complete passing summary**
- [ ] **Step 2: Run `pnpm lint` and resolve every introduced error**
- [ ] **Step 3: Run `pnpm exec tsc --noEmit` and resolve every introduced type error**
- [ ] **Step 4: Run `pnpm build` and verify production route compilation succeeds**
- [ ] **Step 5: Run `git diff --check` and inspect `git status --short` for accidental files or secrets**
- [ ] **Step 6: Review implementation against every section of `docs/superpowers/specs/2026-07-10-tenant-share-quota-design.md`**
- [ ] **Step 7: Commit verification fixes with `fix: complete tenant quota integration` when needed**
