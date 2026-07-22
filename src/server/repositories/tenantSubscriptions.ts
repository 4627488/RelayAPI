import "server-only";

import { desc, eq } from "drizzle-orm";
import { getMainOrm } from "@/src/server/db/sqlite";
import { tenantSubscriptions } from "@/src/server/db/schema";

export type TenantSubscription = {
  id: string;
  tenantId: string;
  tenantUserId: string | null;
  credentialId: string;
  name: string;
  units: number;
  unitsPerCredential: number;
  enabled: boolean;
  priority: number;
  estimatedFiveHourNanoUsd: string | null;
  estimatedSevenDayNanoUsd: string | null;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function listTenantSubscriptions(tenantId?: string) {
  const query = getMainOrm().select().from(tenantSubscriptions);
  const rows = tenantId
    ? query.where(eq(tenantSubscriptions.tenantId, tenantId)).orderBy(desc(tenantSubscriptions.priority)).all()
    : query.orderBy(desc(tenantSubscriptions.priority)).all();
  return rows.map(toRecord);
}

export function listActiveTenantSubscriptions(tenantId: string, now = new Date()) {
  return listTenantSubscriptions(tenantId).filter((item) =>
    item.enabled && item.startsAt <= now.toISOString() && (!item.expiresAt || item.expiresAt > now.toISOString()),
  );
}

export function listActiveTenantSubscriptionsForUser(
  tenantId: string,
  tenantUserId: string,
  now = new Date(),
) {
  return listActiveTenantSubscriptions(tenantId, now).filter(
    (item) => item.tenantUserId === tenantUserId,
  );
}

export function getTenantSubscription(id: string) {
  const row = getMainOrm().select().from(tenantSubscriptions).where(eq(tenantSubscriptions.id, id)).get();
  return row ? toRecord(row) : null;
}

export function insertTenantSubscription(input: Omit<TenantSubscription, "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  getMainOrm().insert(tenantSubscriptions).values({
    ...input,
    enabled: input.enabled ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  }).run();
  return getTenantSubscription(input.id)!;
}

export function updateTenantSubscription(id: string, patch: Partial<Omit<TenantSubscription, "id" | "createdAt" | "updatedAt">>) {
  const { enabled, ...rest } = patch;
  getMainOrm().update(tenantSubscriptions).set({
    ...rest,
    ...(enabled !== undefined ? { enabled: enabled ? 1 : 0 } : {}),
    updatedAt: new Date().toISOString(),
  }).where(eq(tenantSubscriptions.id, id)).run();
  return getTenantSubscription(id);
}

export function deleteTenantSubscription(id: string) {
  return getMainOrm().delete(tenantSubscriptions).where(eq(tenantSubscriptions.id, id)).run().changes > 0;
}

export function allocatedUnitsForCredential(credentialId: string, excludeId?: string) {
  return listTenantSubscriptions().filter((item) => item.credentialId === credentialId && item.enabled && item.id !== excludeId)
    .reduce((sum, item) => sum + item.units / item.unitsPerCredential, 0);
}

function toRecord(row: typeof tenantSubscriptions.$inferSelect): TenantSubscription {
  return { ...row, enabled: Boolean(row.enabled) };
}
