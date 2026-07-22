import "server-only";

import { HttpError } from "@/src/server/http/errors";
import {
  getProviderCredential,
  listProviderCredentials,
  providerCredentialIdentity,
} from "@/src/server/repositories/providerCredentials";
import {
  getTenantById,
  getTenantOwnerUser,
  getTenantUserById,
  listTenants,
} from "@/src/server/repositories/tenants";
import {
  deleteTenantSubscription,
  getTenantSubscription,
  insertTenantSubscription,
  listTenantSubscriptions,
  updateTenantSubscription,
} from "@/src/server/repositories/tenantSubscriptions";
import { randomId } from "@/src/server/services/crypto";
import { getSubscriptionQuotaState } from "@/src/server/repositories/quotaAccounting";
import { subscriptionQuotaLimits } from "@/src/server/services/tenantQuota";
import {
  providerCapacityUnits,
  providerPlanLabel,
} from "@/src/shared/providerCapabilities";

export function listSubscriptions(tenantId?: string, tenantUserId?: string) {
  return listTenantSubscriptions(tenantId)
    .filter((subscription) => !tenantUserId || subscription.tenantUserId === tenantUserId)
    .map((subscription) => {
      const currentLimits = subscriptionQuotaLimits(subscription);
      const user = subscription.tenantUserId
        ? getTenantUserById(subscription.tenantUserId)
        : null;
      return {
        ...subscription,
        user: user
          ? { id: user.id, email: user.email, displayName: user.displayName }
          : null,
        quota: Object.fromEntries(
          Object.entries(getSubscriptionQuotaState(subscription.id).windows).map(
            ([kind, window]) => [kind, {
              limitNanoUsd: String(currentLimits?.[kind as "5h" | "7d"] ?? window.limitNanoUsd),
              settledNanoUsd: String(window.settledNanoUsd),
              reservedNanoUsd: String(window.reservedNanoUsd),
              resetsAt: window.resetsAt,
            }],
          ),
        ),
      };
    });
}

export function getSubscriptionAllocationOverview() {
  const now = new Date().toISOString();
  const tenants = new Map(listTenants().map((tenant) => [tenant.id, tenant]));
  const subscriptions = listSubscriptions().map((subscription) => {
    const tenant = tenants.get(subscription.tenantId);
    return {
      ...subscription,
      tenant: tenant
        ? { id: tenant.id, name: tenant.name, enabled: tenant.enabled, ownerEmail: tenant.ownerEmail }
        : null,
      lifecycle: !subscription.enabled
        ? "disabled"
        : subscription.startsAt > now
          ? "scheduled"
          : subscription.expiresAt && subscription.expiresAt <= now
            ? "expired"
            : "active",
    };
  });
  const byCredential = new Map<string, typeof subscriptions>();
  for (const subscription of subscriptions) {
    const items = byCredential.get(subscription.credentialId) || [];
    items.push(subscription);
    byCredential.set(subscription.credentialId, items);
  }
  const pools = listProviderCredentials().map((credential) => {
    const allocations = byCredential.get(credential.id) || [];
    const capacityUnits = providerCapacityUnits(credential.provider, credential.planType);
    const normalizedAllocations = allocations.map((item) => ({
      ...item,
      allocatedPoolUnits: item.units / item.unitsPerCredential * capacityUnits,
    }));
    const allocatedUnits = normalizedAllocations
      .filter((item) => item.lifecycle === "active")
      .reduce((sum, item) => sum + item.allocatedPoolUnits, 0);
    return {
      id: credential.id,
      provider: credential.provider,
      email: credential.email,
      accountId: providerCredentialIdentity(credential),
      planType: credential.planType,
      enabled: credential.enabled,
      expiresAt: credential.expiresAt,
      cooldownUntil: credential.cooldownUntil,
      lastError: credential.lastError,
      capacityUnits,
      allocatedUnits,
      allocationCount: normalizedAllocations.length,
      activeAllocationCount: normalizedAllocations.filter((item) => item.lifecycle === "active").length,
      subscriptions: normalizedAllocations,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      credentialCount: pools.length,
      usableCredentialCount: pools.filter((pool) => pool.enabled).length,
      capacityUnits: pools.reduce((sum, pool) => sum + pool.capacityUnits, 0),
      allocatedUnits: pools.reduce((sum, pool) => sum + pool.allocatedUnits, 0),
      oversoldCredentialCount: pools.filter((pool) => pool.allocatedUnits > pool.capacityUnits).length,
    },
    pools,
  };
}

export function createSubscription(input: Record<string, unknown>) {
  const tenantId = clean(input.tenantId);
  const credentialId = clean(input.credentialId);
  if (!getTenantById(tenantId)) throw new HttpError(404, "tenant_not_found", "Tenant not found");
  const credential = getProviderCredential(credentialId);
  if (!credential) throw new HttpError(404, "provider_credential_not_found", "Credential not found");
  if (!credential.enabled) throw new HttpError(400, "provider_credential_disabled", "Disabled credential cannot receive new allocations");
  const tenant = getTenantById(tenantId);
  if (!tenant?.enabled) throw new HttpError(400, "tenant_disabled", "Disabled tenant cannot receive new allocations");
  const tenantUser = getTenantOwnerUser(tenantId);
  if (!tenantUser?.enabled) throw new HttpError(400, "tenant_user_not_available", "Tenant user must be active before receiving a subscription");
  const units = positiveNumber(input.units, 1);
  const unitsPerCredential = positiveNumber(
    input.unitsPerCredential,
    providerCapacityUnits(credential.provider, credential.planType),
  );
  return insertTenantSubscription({
    id: randomId("sub"), tenantId, tenantUserId: tenantUser.id, credentialId,
    name: clean(input.name) || `${providerPlanLabel(credential.provider, credential.planType)} ${units}/${unitsPerCredential}`,
    units, unitsPerCredential, enabled: input.enabled !== false,
    priority: integer(input.priority, 100),
    estimatedFiveHourNanoUsd: nullableNanoUsd(input.estimatedFiveHourNanoUsd),
    estimatedSevenDayNanoUsd: nullableNanoUsd(input.estimatedSevenDayNanoUsd),
    startsAt: date(input.startsAt) || new Date().toISOString(),
    expiresAt: date(input.expiresAt),
  });
}

export function patchSubscription(id: string, input: Record<string, unknown>) {
  const current = getTenantSubscription(id);
  if (!current) throw new HttpError(404, "subscription_not_found", "Subscription not found");
  const credentialId = input.credentialId === undefined ? current.credentialId : clean(input.credentialId);
  const credential = getProviderCredential(credentialId);
  if (!credential) throw new HttpError(404, "provider_credential_not_found", "Credential not found");
  const units = input.units === undefined ? current.units : positiveNumber(input.units, current.units);
  const defaultUnitsPerCredential = credentialId === current.credentialId
    ? current.unitsPerCredential
    : providerCapacityUnits(credential.provider, credential.planType);
  const unitsPerCredential = input.unitsPerCredential === undefined
    ? defaultUnitsPerCredential
    : positiveNumber(input.unitsPerCredential, defaultUnitsPerCredential);
  return updateTenantSubscription(id, {
    ...(input.name !== undefined ? { name: clean(input.name) || current.name } : {}),
    credentialId, units, unitsPerCredential,
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.priority !== undefined ? { priority: integer(input.priority, 100) } : {}),
    ...(input.estimatedFiveHourNanoUsd !== undefined ? { estimatedFiveHourNanoUsd: nullableNanoUsd(input.estimatedFiveHourNanoUsd) } : {}),
    ...(input.estimatedSevenDayNanoUsd !== undefined ? { estimatedSevenDayNanoUsd: nullableNanoUsd(input.estimatedSevenDayNanoUsd) } : {}),
    ...(input.startsAt !== undefined ? { startsAt: date(input.startsAt) || current.startsAt } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: date(input.expiresAt) } : {}),
  })!;
}

export function removeSubscription(id: string) {
  if (!deleteTenantSubscription(id)) throw new HttpError(404, "subscription_not_found", "Subscription not found");
}

function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function integer(value: unknown, fallback: number) { const n = Number(value); return Number.isFinite(n) ? Math.floor(n) : fallback; }
function positiveNumber(value: unknown, fallback: number) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function date(value: unknown) { const text = clean(value); return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null; }
function nullableNanoUsd(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  let parsed: bigint;
  try { parsed = typeof value === "bigint" ? value : BigInt(String(value)); }
  catch { throw new HttpError(400, "invalid_estimated_quota", "Estimated quota must be a whole nano-USD amount"); }
  if (parsed <= 0n) throw new HttpError(400, "invalid_estimated_quota", "Estimated quota must be greater than zero");
  return String(parsed);
}
