import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { getCodexCredentialById } from "@/src/server/repositories/codexCredentials";
import { getTenantById } from "@/src/server/repositories/tenants";
import {
  deleteTenantSubscription,
  getTenantSubscription,
  insertTenantSubscription,
  listTenantSubscriptions,
  updateTenantSubscription,
} from "@/src/server/repositories/tenantSubscriptions";
import { randomId } from "@/src/server/services/crypto";
import { codexPlanLabel, codexPlanShares } from "@/src/shared/codexPlans";

export function listSubscriptions(tenantId?: string) {
  return listTenantSubscriptions(tenantId);
}

export function createSubscription(input: Record<string, unknown>) {
  const tenantId = clean(input.tenantId);
  const credentialId = clean(input.credentialId);
  if (!getTenantById(tenantId)) throw new HttpError(404, "tenant_not_found", "Tenant not found");
  const credential = getCodexCredentialById(credentialId);
  if (!credential) throw new HttpError(404, "codex_credential_not_found", "Credential not found");
  const units = positiveInt(input.units, 1);
  const unitsPerCredential = positiveInt(input.unitsPerCredential, codexPlanShares(credential.planType));
  return insertTenantSubscription({
    id: randomId("sub"), tenantId, credentialId,
    name: clean(input.name) || `${codexPlanLabel(credential.planType)} ${units}/${unitsPerCredential}`,
    units, unitsPerCredential, enabled: input.enabled !== false,
    priority: integer(input.priority, 100),
    startsAt: date(input.startsAt) || new Date().toISOString(),
    expiresAt: date(input.expiresAt),
  });
}

export function patchSubscription(id: string, input: Record<string, unknown>) {
  const current = getTenantSubscription(id);
  if (!current) throw new HttpError(404, "subscription_not_found", "Subscription not found");
  const credentialId = input.credentialId === undefined ? current.credentialId : clean(input.credentialId);
  if (!getCodexCredentialById(credentialId)) throw new HttpError(404, "codex_credential_not_found", "Credential not found");
  const units = input.units === undefined ? current.units : positiveInt(input.units, current.units);
  const unitsPerCredential = input.unitsPerCredential === undefined ? current.unitsPerCredential : positiveInt(input.unitsPerCredential, current.unitsPerCredential);
  return updateTenantSubscription(id, {
    ...(input.name !== undefined ? { name: clean(input.name) || current.name } : {}),
    credentialId, units, unitsPerCredential,
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.priority !== undefined ? { priority: integer(input.priority, 100) } : {}),
    ...(input.startsAt !== undefined ? { startsAt: date(input.startsAt) || current.startsAt } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: date(input.expiresAt) } : {}),
  })!;
}

export function removeSubscription(id: string) {
  if (!deleteTenantSubscription(id)) throw new HttpError(404, "subscription_not_found", "Subscription not found");
}

function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function integer(value: unknown, fallback: number) { const n = Number(value); return Number.isFinite(n) ? Math.floor(n) : fallback; }
function positiveInt(value: unknown, fallback: number) { return Math.max(1, integer(value, fallback)); }
function date(value: unknown) { const text = clean(value); return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null; }
