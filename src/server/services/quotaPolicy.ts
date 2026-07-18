import "server-only";

import { HttpError } from "@/src/server/http/errors";
import {
  reserveSubscriptionQuota,
  type SubscriptionQuotaState,
} from "@/src/server/repositories/quotaAccounting";
import {
  getApiKeyDailyUsage,
  getApiKeyRequestCountSince,
  getTenantDailyUsage,
  getTenantRequestCountSince,
} from "@/src/server/repositories/quotaUsage";

export type QuotaMetric = "requests" | "tokens" | "cost_nano_usd";
export type QuotaWindow = "minute" | "day" | "upstream_5h" | "upstream_7d";
export type QuotaSubject = "api_key" | "tenant" | "subscription";

export interface QuotaPolicy {
  subject: QuotaSubject;
  subjectId: string;
  metric: QuotaMetric;
  window: QuotaWindow;
  limit: number | bigint;
}

export interface CostQuotaPolicy extends QuotaPolicy {
  subject: "subscription";
  metric: "cost_nano_usd";
  window: "upstream_5h" | "upstream_7d";
  limit: bigint;
  resetsAt: string;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const inFlightRateLimitBuckets = new Map<string, number[]>();

export function enforceRequestQuotaPolicies(input: {
  apiKeyId: string;
  apiKeyTokenLimitDaily: number | null;
  apiKeyRateLimitPerMinute: number | null;
  tenantId?: string | null;
  tenantTokenLimitDaily?: number | null;
  tenantRateLimitPerMinute?: number | null;
}) {
  const policies = requestQuotaPolicies(input);
  for (const policy of policies) {
    if (policy.metric === "tokens") enforceTokenPolicy(policy);
    if (policy.metric === "requests") enforceRequestRatePolicy(policy);
  }
  return policies;
}

export function requestQuotaPolicies(input: {
  apiKeyId: string;
  apiKeyTokenLimitDaily: number | null;
  apiKeyRateLimitPerMinute: number | null;
  tenantId?: string | null;
  tenantTokenLimitDaily?: number | null;
  tenantRateLimitPerMinute?: number | null;
}): QuotaPolicy[] {
  const policies: QuotaPolicy[] = [];
  if (input.apiKeyTokenLimitDaily) policies.push({ subject: "api_key", subjectId: input.apiKeyId, metric: "tokens", window: "day", limit: input.apiKeyTokenLimitDaily });
  if (input.apiKeyRateLimitPerMinute) policies.push({ subject: "api_key", subjectId: input.apiKeyId, metric: "requests", window: "minute", limit: input.apiKeyRateLimitPerMinute });
  if (input.tenantId && input.tenantTokenLimitDaily) policies.push({ subject: "tenant", subjectId: input.tenantId, metric: "tokens", window: "day", limit: input.tenantTokenLimitDaily });
  if (input.tenantId && input.tenantRateLimitPerMinute) policies.push({ subject: "tenant", subjectId: input.tenantId, metric: "requests", window: "minute", limit: input.tenantRateLimitPerMinute });
  return policies;
}

export function subscriptionCostQuotaPolicies(input: {
  subscriptionId: string;
  limits: Record<"5h" | "7d", bigint>;
  resetsAt: Record<"5h" | "7d", string>;
}): CostQuotaPolicy[] {
  return (["5h", "7d"] as const).map((kind) => ({
    subject: "subscription",
    subjectId: input.subscriptionId,
    metric: "cost_nano_usd",
    window: kind === "5h" ? "upstream_5h" : "upstream_7d",
    limit: input.limits[kind],
    resetsAt: input.resetsAt[kind],
  }));
}

export function reserveCostQuotaPolicies(input: {
  requestId: string;
  reserveNanoUsd: bigint;
  policies: CostQuotaPolicy[];
  now: Date;
  expiresAt: Date;
}): SubscriptionQuotaState {
  const subscriptionId = input.policies[0]?.subjectId;
  const fiveHour = input.policies.find((policy) => policy.window === "upstream_5h");
  const sevenDay = input.policies.find((policy) => policy.window === "upstream_7d");
  if (!subscriptionId || !fiveHour || !sevenDay ||
      input.policies.some((policy) => policy.subjectId !== subscriptionId)) {
    throw new Error("A complete subscription cost quota policy set is required");
  }
  return reserveSubscriptionQuota({
    requestId: input.requestId,
    subscriptionId,
    reserveNanoUsd: input.reserveNanoUsd,
    windows: {
      "5h": { limitNanoUsd: fiveHour.limit, resetsAt: fiveHour.resetsAt },
      "7d": { limitNanoUsd: sevenDay.limit, resetsAt: sevenDay.resetsAt },
    },
    now: input.now,
    expiresAt: input.expiresAt,
  });
}

function enforceTokenPolicy(policy: QuotaPolicy) {
  const usage = policy.subject === "api_key"
    ? getApiKeyDailyUsage(policy.subjectId)
    : getTenantDailyUsage(policy.subjectId);
  if (usage < Number(policy.limit)) return;
  throw new HttpError(
    429,
    policy.subject === "api_key"
      ? "daily_token_limit_exceeded"
      : "tenant_daily_token_limit_exceeded",
    policy.subject === "api_key"
      ? "API key daily token limit has been reached"
      : "Tenant daily token limit has been reached",
  );
}

function enforceRequestRatePolicy(policy: QuotaPolicy) {
  const bucketId = `${policy.subject}:${policy.subjectId}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recentInFlight = (inFlightRateLimitBuckets.get(bucketId) || []).filter(
    (timestamp) => timestamp >= windowStart,
  );
  const persistedCount = policy.subject === "api_key"
    ? getApiKeyRequestCountSince(policy.subjectId, new Date(windowStart))
    : getTenantRequestCountSince(policy.subjectId, new Date(windowStart));
  if (persistedCount + recentInFlight.length >= Number(policy.limit)) {
    inFlightRateLimitBuckets.set(bucketId, recentInFlight);
    throw new HttpError(429, "rate_limit_exceeded", "Rate limit has been reached");
  }
  recentInFlight.push(now);
  inFlightRateLimitBuckets.set(bucketId, recentInFlight);
}
