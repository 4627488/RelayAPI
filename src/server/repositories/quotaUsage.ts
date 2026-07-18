import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";

import { getLogOrm } from "@/src/server/db/sqlite";
import {
  requestLogs,
  usageDailyBuckets,
} from "@/src/server/db/schema";
import { getGlobalTimeZoneSetting } from "@/src/server/services/settings";
import { instantToDateKey } from "@/src/shared/time";

export function getApiKeyDailyUsage(apiKeyId: string, day = new Date()) {
  return dailyTokenUsage(eq(usageDailyBuckets.apiKeyId, apiKeyId), day);
}

export function getTenantDailyUsage(tenantId: string, day = new Date()) {
  return dailyTokenUsage(eq(usageDailyBuckets.tenantId, tenantId), day);
}

export function getApiKeyRequestCountSince(apiKeyId: string, since: Date) {
  return requestCountSince(eq(requestLogs.apiKeyId, apiKeyId), since);
}

export function getTenantRequestCountSince(tenantId: string, since: Date) {
  return requestCountSince(eq(requestLogs.tenantId, tenantId), since);
}

function dailyTokenUsage(
  subjectCondition: ReturnType<typeof eq>,
  day: Date,
) {
  const bucketDate = instantToDateKey(day, getGlobalTimeZoneSetting());
  const row = getLogOrm()
    .select({
      totalTokens: sql<number>`COALESCE(SUM(${usageDailyBuckets.totalTokens}), 0)`,
    })
    .from(usageDailyBuckets)
    .where(and(eq(usageDailyBuckets.bucketDate, bucketDate), subjectCondition))
    .get();
  return Number(row?.totalTokens || 0);
}

function requestCountSince(
  subjectCondition: ReturnType<typeof eq>,
  since: Date,
) {
  const row = getLogOrm()
    .select({ count: sql<number>`COUNT(*)` })
    .from(requestLogs)
    .where(and(subjectCondition, gte(requestLogs.startedAt, since.toISOString())))
    .get();
  return Number(row?.count || 0);
}
