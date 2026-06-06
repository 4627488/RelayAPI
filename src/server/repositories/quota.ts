import "server-only";

import { eq } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import { codexQuotaCache } from "@/src/server/db/schema";
import { jsonStringify, safeJsonParse } from "@/src/server/services/crypto";

export interface CodexQuotaCacheRecord {
  credentialId: string;
  status: string;
  cache: Record<string, unknown>;
  retrievedAt: string;
  updatedAt: string;
}

export interface UpsertCodexQuotaCacheInput {
  credentialId: string;
  status: string;
  cache: Record<string, unknown>;
  retrievedAt: string;
}

export function getCodexQuotaCacheByCredentialId(credentialId: string) {
  const row = getMainOrm()
    .select()
    .from(codexQuotaCache)
    .where(eq(codexQuotaCache.credentialId, credentialId))
    .get();
  return row ? toCodexQuotaCacheRecord(row) : null;
}

export function upsertCodexQuotaCache(input: UpsertCodexQuotaCacheInput) {
  const now = new Date().toISOString();
  // Quota cache lives in the main DB because routing may later use current
  // quota state when automatically selecting channels.
  getMainOrm()
    .insert(codexQuotaCache)
    .values({
      credentialId: input.credentialId,
      status: input.status,
      cacheJson: jsonStringify(input.cache),
      retrievedAt: input.retrievedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: codexQuotaCache.credentialId,
      set: {
        status: input.status,
        cacheJson: jsonStringify(input.cache),
        retrievedAt: input.retrievedAt,
        updatedAt: now,
      },
    })
    .run();
  return getCodexQuotaCacheByCredentialId(input.credentialId);
}

function toCodexQuotaCacheRecord(
  row: typeof codexQuotaCache.$inferSelect,
): CodexQuotaCacheRecord {
  return {
    credentialId: row.credentialId,
    status: row.status,
    cache: safeJsonParse<Record<string, unknown>>(row.cacheJson, {}),
    retrievedAt: row.retrievedAt,
    updatedAt: row.updatedAt,
  };
}
