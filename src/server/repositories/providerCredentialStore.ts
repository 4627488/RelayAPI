import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { codexCredentials } from "@/src/server/db/schema";
import { getMainOrm } from "@/src/server/db/sqlite";
import type { ProviderId } from "@/src/shared/types/entities";

export type ProviderCredentialRow = typeof codexCredentials.$inferSelect;
export type ProviderCredentialInsert = typeof codexCredentials.$inferInsert;

export function listProviderCredentialRows(
  provider: ProviderId,
): ProviderCredentialRow[] {
  return getMainOrm()
    .select()
    .from(codexCredentials)
    .where(eq(codexCredentials.provider, provider))
    .orderBy(desc(codexCredentials.createdAt))
    .all();
}

export function getProviderCredentialRow(
  id: string,
  provider: ProviderId,
): ProviderCredentialRow | null {
  return getMainOrm()
    .select()
    .from(codexCredentials)
    .where(
      and(
        eq(codexCredentials.id, id),
        eq(codexCredentials.provider, provider),
      ),
    )
    .get() || null;
}

export function upsertProviderCredentialRow(
  values: ProviderCredentialInsert,
) {
  getMainOrm()
    .insert(codexCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: codexCredentials.id,
      set: {
        provider: values.provider,
        email: values.email,
        accountId: values.accountId,
        planType: values.planType,
        tokenEnvelope: values.tokenEnvelope,
        proxyEnvelope: values.proxyEnvelope,
        enabled: values.enabled,
        priority: values.priority,
        weight: values.weight,
        expiresAt: values.expiresAt,
        lastRefreshAt: values.lastRefreshAt,
        lastUsedAt: values.lastUsedAt,
        metadataJson: values.metadataJson,
        updatedAt: values.updatedAt,
      },
    })
    .run();
}

export function patchProviderCredentialRow(
  id: string,
  provider: ProviderId,
  patch: Partial<ProviderCredentialInsert>,
) {
  return getMainOrm()
    .update(codexCredentials)
    .set(patch)
    .where(
      and(
        eq(codexCredentials.id, id),
        eq(codexCredentials.provider, provider),
      ),
    )
    .run().changes > 0;
}

export function deleteProviderCredentialRow(
  id: string,
  provider: ProviderId,
) {
  return getMainOrm()
    .delete(codexCredentials)
    .where(
      and(
        eq(codexCredentials.id, id),
        eq(codexCredentials.provider, provider),
      ),
    )
    .run().changes > 0;
}
