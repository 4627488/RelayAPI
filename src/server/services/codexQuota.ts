import "server-only";

import crypto from "node:crypto";

import { serverConfig } from "@/src/server/config/env";
import { HttpError, logServerError } from "@/src/server/http/errors";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  getCodexCredentialById,
  updateCodexCredential,
} from "@/src/server/repositories/codexCredentials";
import {
  getCodexQuotaCacheByCredentialId,
  upsertCodexQuotaCache,
} from "@/src/server/repositories/quota";
import { ensureFreshCredential } from "@/src/server/services/codexCredentials";
import {
  getEffectiveCodexUserAgent,
  getGlobalProxySetting,
  getGlobalTimeZoneSetting,
} from "@/src/server/services/settings";
import { recordCodexQuotaObservation } from "@/src/server/services/quotaCalibration";
import { formatInstant } from "@/src/shared/time";
import type {
  CodexCredentialRecord,
  CodexCredentialWithTokens,
} from "@/src/shared/types/entities";

export const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const WHAM_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const WHAM_RESET_CREDITS_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

const WINDOW_5H_SECONDS = 5 * 60 * 60;
const WINDOW_7D_SECONDS = 7 * 24 * 60 * 60;

type CodexQuotaStatus =
  | "unknown"
  | "exhausted"
  | "low"
  | "medium"
  | "high"
  | "full";

type CacheState = "cached" | "fresh" | "missing";

type RawObject = Record<string, unknown>;

interface QuotaWindow {
  id: string;
  label: string;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_label: string;
  resets_at: string | null;
  exhausted: boolean;
}

interface CodexQuotaReport {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  status: CodexQuotaStatus;
  windows: QuotaWindow[];
  additional_windows: QuotaWindow[];
  retrieved_at: string;
  raw?: unknown;
}

interface PublicCodexQuotaReport extends CodexQuotaReport {
  cached: boolean;
  cache_state: CacheState;
}

interface MissingCodexQuotaReport {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  status: "not_cached";
  windows: [];
  additional_windows: [];
  retrieved_at: string;
  cached: false;
  cache_state: "missing";
  message: string;
}

interface CodexResetCredit {
  id: string;
  available: boolean;
  expires_at: string | null;
  raw?: unknown;
}

interface CodexResetCreditsReport {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  available_count: number;
  credits: CodexResetCredit[];
  retrieved_at: string;
  raw?: unknown;
}

interface CodexResetCreditConsumeReport {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  credit_id: string;
  redeem_request_id: string;
  code: string;
  windows_reset: number | null;
  consumed_at: string;
  raw?: unknown;
}

export async function getCodexQuota({
  credentialId,
  forceRefresh = false,
  includeRaw = false,
}: {
  credentialId: string;
  forceRefresh?: boolean;
  includeRaw?: boolean;
}): Promise<PublicCodexQuotaReport | MissingCodexQuotaReport> {
  if (!credentialId) {
    throw new HttpError(
      400,
      "missing_codex_credential_id",
      "Codex credential id is required",
    );
  }

  if (!forceRefresh) {
    const cached = getCodexQuotaCacheByCredentialId(credentialId);
    if (cached) {
      return markQuotaCacheState(cached.cache, "cached");
    }
    const credential = getCodexCredentialById(credentialId);
    if (!credential) {
      throw new HttpError(
        404,
        "codex_credential_not_found",
        "Codex credential not found",
      );
    }
    return missingQuotaResponse(credential);
  }

  let credential: CodexCredentialWithTokens | null = null;
  try {
    credential = await ensureFreshCredential(credentialId);
    if (!credential.tokens.access_token) {
      throw new HttpError(
        400,
        "missing_access_token",
        "Saved Codex credential does not contain an access token",
      );
    }
    if (!credential.accountId) {
      throw new HttpError(
        400,
        "missing_account_id",
        "Saved Codex credential does not contain an account id",
      );
    }

    const response = await proxiedFetch(
      WHAM_USAGE_URL,
      {
        method: "GET",
        headers: buildQuotaHeaders({
          accessToken: credential.tokens.access_token,
          accountId: credential.accountId,
          userAgent: getEffectiveCodexUserAgent(credential),
        }),
        signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
      },
      credential.proxy?.enabled
        ? credential.proxy
        : credential.useGlobalProxy
          ? getGlobalProxySetting()
          : null,
    );

    const text = await response.text();
    const body = parseMaybeJson<unknown>(text) || { raw: text };
    if (!response.ok) {
      throw new HttpError(
        response.status,
        "codex_quota_request_failed",
        `Quota request failed with HTTP ${response.status}`,
        {
          upstreamStatus: response.status,
          upstreamStatusText: response.statusText,
          upstreamBody: body,
        },
      );
    }

    const report = normalizeQuotaResponse(body, credential);
    if (report.plan_type && report.plan_type !== credential.planType) {
      updateCodexCredential(credential.id, { planType: report.plan_type });
    }
    // Quota cache belongs to the main DB because automatic channel routing may
    // use current quota state in a later routing slice.
    upsertCodexQuotaCache({
      credentialId: credential.id,
      status: report.status,
      cache: reportToRecord(report),
      retrievedAt: report.retrieved_at,
    });
    recordCodexQuotaObservation({
      credentialId: credential.id,
      planType: report.plan_type,
      observedAt: report.retrieved_at,
      windows: report.windows.flatMap((window) =>
        window.id === "code-5h" || window.id === "code-7d"
          ? [{
              kind: window.id === "code-5h" ? "5h" as const : "7d" as const,
              usedPercent: window.used_percent,
              resetsAt: window.resets_at,
            }]
          : [],
      ),
    });

    const publicReport = markQuotaCacheState(reportToRecord(report), "fresh");
    if (includeRaw) {
      return { ...publicReport, raw: body };
    }
    return publicReport;
  } catch (error) {
    logServerError(error, {
      operation: "codex.quota.refresh",
      metadata: {
        ...(credential
          ? codexQuotaCredentialLogMetadata(credential)
          : { credentialId }),
        includeRaw,
        forceRefresh,
      },
    });
    throw error;
  }
}

export async function getCodexResetCredits({
  credentialId,
  includeRaw = false,
}: {
  credentialId: string;
  includeRaw?: boolean;
}): Promise<CodexResetCreditsReport> {
  const credential = await getCredentialForWham(credentialId);
  try {
    const body = await requestWhamJson({
      credential,
      url: WHAM_RESET_CREDITS_URL,
      method: "GET",
      errorCode: "codex_reset_credits_request_failed",
      errorMessage: "Codex reset credits request failed",
    });
    const report = normalizeResetCreditsResponse(body, credential);
    return includeRaw ? { ...report, raw: body } : report;
  } catch (error) {
    logServerError(error, {
      operation: "codex.reset_credits.query",
      metadata: { ...codexQuotaCredentialLogMetadata(credential), includeRaw },
    });
    throw error;
  }
}

export async function consumeCodexResetCredit({
  credentialId,
  creditId,
  redeemRequestId,
  includeRaw = false,
}: {
  credentialId: string;
  creditId?: string;
  redeemRequestId?: string;
  includeRaw?: boolean;
}): Promise<CodexResetCreditConsumeReport> {
  const credential = await getCredentialForWham(credentialId);
  try {
    const selectedCreditId =
      cleanString(creditId) ||
      firstAvailableResetCreditId(
        normalizeResetCreditsResponse(
          await requestWhamJson({
            credential,
            url: WHAM_RESET_CREDITS_URL,
            method: "GET",
            errorCode: "codex_reset_credits_request_failed",
            errorMessage: "Codex reset credits request failed",
          }),
          credential,
        ),
      );

    if (!selectedCreditId) {
      throw new HttpError(
        400,
        "codex_reset_credit_unavailable",
        "No available Codex reset credit found for this credential",
      );
    }

    const requestId = cleanString(redeemRequestId) || crypto.randomUUID();
    const body = await requestWhamJson({
      credential,
      url: WHAM_RESET_CREDITS_CONSUME_URL,
      method: "POST",
      body: {
        credit_id: selectedCreditId,
        redeem_request_id: requestId,
      },
      errorCode: "codex_reset_credit_consume_failed",
      errorMessage: "Codex reset credit consume request failed",
    });

    const root = objectFrom(body) || {};
    return {
      provider: "codex",
      credential_id: credential.id,
      account_id: credential.accountId,
      email: credential.email,
      plan_type: credential.planType,
      credit_id: selectedCreditId,
      redeem_request_id: requestId,
      code: cleanString(root.code),
      windows_reset: numberPtr(
        firstValue(root.windows_reset, root.windowsReset),
      ),
      consumed_at: new Date().toISOString(),
      ...(includeRaw ? { raw: body } : {}),
    };
  } catch (error) {
    logServerError(error, {
      operation: "codex.reset_credits.consume",
      metadata: {
        ...codexQuotaCredentialLogMetadata(credential),
        creditId: creditId ? "[provided]" : null,
        redeemRequestId: redeemRequestId ? "[provided]" : null,
        includeRaw,
      },
    });
    throw error;
  }
}

async function getCredentialForWham(credentialId: string) {
  if (!credentialId) {
    throw new HttpError(
      400,
      "missing_codex_credential_id",
      "Codex credential id is required",
    );
  }

  const credential = await ensureFreshCredential(credentialId);
  if (!credential.tokens.access_token) {
    throw new HttpError(
      400,
      "missing_access_token",
      "Saved Codex credential does not contain an access token",
    );
  }
  if (!credential.accountId) {
    throw new HttpError(
      400,
      "missing_account_id",
      "Saved Codex credential does not contain an account id",
    );
  }
  return credential;
}

async function requestWhamJson({
  body,
  credential,
  errorCode,
  errorMessage,
  method,
  url,
}: {
  body?: Record<string, unknown>;
  credential: CodexCredentialWithTokens;
  errorCode: string;
  errorMessage: string;
  method: "GET" | "POST";
  url: string;
}) {
  const response = await proxiedFetch(
    url,
    {
      method,
      headers: buildQuotaHeaders({
        accessToken: credential.tokens.access_token,
        accountId: credential.accountId,
        userAgent: getEffectiveCodexUserAgent(credential),
      }),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
    },
    credential.proxy?.enabled
      ? credential.proxy
      : credential.useGlobalProxy
        ? getGlobalProxySetting()
        : null,
  );

  const text = await response.text();
  const parsed = parseMaybeJson<unknown>(text) || { raw: text };
  if (!response.ok) {
    throw new HttpError(
      response.status,
      errorCode,
      `${errorMessage} with HTTP ${response.status}`,
      {
        upstreamStatus: response.status,
        upstreamStatusText: response.statusText,
        upstreamBody: parsed,
      },
    );
  }
  return parsed;
}

function markQuotaCacheState(
  report: Record<string, unknown>,
  state: Exclude<CacheState, "missing">,
): PublicCodexQuotaReport {
  const cleanReport = removeRaw(report) as unknown as CodexQuotaReport;
  return {
    ...cleanReport,
    cached: state === "cached",
    cache_state: state,
  };
}

function missingQuotaResponse(
  credential: CodexCredentialRecord,
): MissingCodexQuotaReport {
  return {
    provider: "codex",
    credential_id: credential.id,
    account_id: credential.accountId,
    email: credential.email,
    plan_type: credential.planType,
    status: "not_cached",
    windows: [],
    additional_windows: [],
    retrieved_at: "",
    cached: false,
    cache_state: "missing",
    message: "Quota has not been refreshed for this credential yet.",
  };
}

function buildQuotaHeaders(input: {
  accessToken: string;
  accountId: string;
  userAgent: string;
}) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": input.userAgent,
    "Chatgpt-Account-Id": input.accountId,
  };
}

function normalizeResetCreditsResponse(
  payload: unknown,
  credential: CodexCredentialRecord,
): CodexResetCreditsReport {
  const root = objectFrom(payload) || {};
  const rawCredits = arrayFrom(
    firstValue(root.credits, root.data, root.items, root.reset_credits),
  );
  const credits = rawCredits
    .map(normalizeResetCredit)
    .filter((credit): credit is CodexResetCredit => credit !== null);
  const availableCount = numberPtr(
    firstValue(root.available_count, root.availableCount),
  );
  return {
    provider: "codex",
    credential_id: credential.id,
    account_id: credential.accountId,
    email: credential.email,
    plan_type: credential.planType,
    available_count:
      availableCount ?? credits.filter((credit) => credit.available).length,
    credits,
    retrieved_at: new Date().toISOString(),
  };
}

function normalizeResetCredit(value: unknown): CodexResetCredit | null {
  const root = objectFrom(value);
  if (!root) {
    return null;
  }
  const id = cleanString(
    firstValue(root.id, root.credit_id, root.creditId, root.uuid),
  );
  if (!id) {
    return null;
  }
  const availableValue = firstValue(
    root.available,
    root.is_available,
    root.isAvailable,
    root.consumed === undefined ? undefined : !booleanFromAny(root.consumed),
  );
  return {
    id,
    available:
      availableValue === undefined ? true : booleanFromAny(availableValue),
    expires_at: normalizeMaybeDate(
      firstValue(root.expires_at, root.expiresAt, root.expiration_time),
    ),
    raw: value,
  };
}

function firstAvailableResetCreditId(report: CodexResetCreditsReport) {
  return report.credits.find((credit) => credit.available)?.id || "";
}

function codexQuotaCredentialLogMetadata(
  credential: CodexCredentialWithTokens,
) {
  return {
    credentialId: credential.id,
    email: credential.email,
    accountId: credential.accountId,
    planType: credential.planType,
    useGlobalProxy: credential.useGlobalProxy,
    proxy: credential.proxy?.enabled
      ? {
          type: credential.proxy.type,
          host: credential.proxy.host,
          port: credential.proxy.port,
        }
      : null,
  };
}

function normalizeQuotaResponse(
  payload: unknown,
  credential: CodexCredentialRecord,
): CodexQuotaReport {
  const root = objectFrom(payload) || {};
  const planType = cleanString(
    firstValue(root.plan_type, root.planType, credential.planType),
  );
  const windows = parseCodexWindows(root);
  return {
    provider: "codex",
    credential_id: credential.id,
    account_id: credential.accountId,
    email: credential.email,
    plan_type: planType,
    status: deriveCodexStatus(windows),
    windows,
    additional_windows: parseAdditionalWindows(root),
    retrieved_at: new Date().toISOString(),
  };
}

function parseCodexWindows(payload: RawObject) {
  const rateLimit = objectFrom(
    firstValue(payload.rate_limit, payload.rateLimit),
  );
  const [fiveHour, weekly] = findQuotaWindows(rateLimit);
  const limitReached = firstValue(
    rateLimit?.limit_reached,
    rateLimit?.limitReached,
  );
  const allowed = firstValue(rateLimit?.allowed);
  return [
    buildWindow("code-5h", "5h", fiveHour, limitReached, allowed),
    buildWindow("code-7d", "7d", weekly, limitReached, allowed),
  ].filter((window): window is QuotaWindow => window !== null);
}

function parseAdditionalWindows(payload: RawObject) {
  const raw = firstValue(
    payload.additional_rate_limits,
    payload.additionalRateLimits,
  );
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item, index) => {
    const entry = objectFrom(item);
    const rateLimit = objectFrom(
      firstValue(entry?.rate_limit, entry?.rateLimit),
    );
    if (!entry || !rateLimit) {
      return [];
    }

    const name =
      cleanString(
        firstValue(
          entry.limit_name,
          entry.limitName,
          entry.metered_feature,
          entry.meteredFeature,
        ),
      ) || `additional-${index + 1}`;
    const limitReached = firstValue(
      rateLimit.limit_reached,
      rateLimit.limitReached,
    );
    const allowed = firstValue(rateLimit.allowed);
    return [
      buildWindow(
        `${name}-primary`,
        `${name} 5h`,
        objectFrom(
          firstValue(rateLimit.primary_window, rateLimit.primaryWindow),
        ),
        limitReached,
        allowed,
      ),
      buildWindow(
        `${name}-secondary`,
        `${name} 7d`,
        objectFrom(
          firstValue(rateLimit.secondary_window, rateLimit.secondaryWindow),
        ),
        limitReached,
        allowed,
      ),
    ].filter((window): window is QuotaWindow => window !== null);
  });
}

function findQuotaWindows(
  rateLimit: RawObject | null,
): [RawObject | null, RawObject | null] {
  if (!rateLimit) {
    return [null, null];
  }
  const primary = objectFrom(
    firstValue(rateLimit.primary_window, rateLimit.primaryWindow),
  );
  const secondary = objectFrom(
    firstValue(rateLimit.secondary_window, rateLimit.secondaryWindow),
  );
  let fiveHour: RawObject | null = null;
  let weekly: RawObject | null = null;

  for (const candidate of [primary, secondary]) {
    if (!candidate) {
      continue;
    }
    const duration = numberFromAny(
      firstValue(candidate.limit_window_seconds, candidate.limitWindowSeconds),
    );
    if (duration === WINDOW_5H_SECONDS && !fiveHour) {
      fiveHour = candidate;
    }
    if (duration === WINDOW_7D_SECONDS && !weekly) {
      weekly = candidate;
    }
  }

  return [fiveHour || primary, weekly || secondary];
}

function buildWindow(
  id: string,
  label: string,
  window: RawObject | null,
  limitReached: unknown,
  allowed: unknown,
): QuotaWindow | null {
  if (!window) {
    return null;
  }
  const usedPercent = deduceUsedPercent(window, limitReached, allowed);
  const remainingPercent =
    usedPercent === null ? null : clamp(100 - usedPercent, 0, 100);
  return {
    id,
    label,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    reset_label: formatResetLabel(window),
    resets_at: resetInstant(window),
    exhausted: usedPercent !== null && usedPercent >= 100,
  };
}

function resetInstant(window: RawObject) {
  const resetAt = numberFromAny(firstValue(window.reset_at, window.resetAt));
  if (resetAt > 0) return new Date(resetAt * 1000).toISOString();
  return null;
}

function deduceUsedPercent(
  window: RawObject,
  limitReached: unknown,
  allowed: unknown,
) {
  const used = numberPtr(firstValue(window.used_percent, window.usedPercent));
  if (used !== null) {
    return clamp(used, 0, 100);
  }
  if (
    (booleanFromAny(limitReached) || allowed === false) &&
    formatResetLabel(window) !== "-"
  ) {
    return 100;
  }
  return null;
}

function deriveCodexStatus(windows: QuotaWindow[]): CodexQuotaStatus {
  const weekly = windows.find((window) => window.id === "code-7d");
  if (!weekly || weekly.remaining_percent === null) {
    return "unknown";
  }
  const remaining = weekly.remaining_percent;
  if (remaining <= 0) {
    return "exhausted";
  }
  if (remaining <= 30) {
    return "low";
  }
  if (remaining <= 70) {
    return "medium";
  }
  if (remaining < 100) {
    return "high";
  }
  return "full";
}

function formatResetLabel(window: RawObject) {
  const resetAt = numberFromAny(firstValue(window.reset_at, window.resetAt));
  if (resetAt > 0) {
    return formatLocalMinute(new Date(resetAt * 1000));
  }
  return "-";
}

function formatLocalMinute(date: Date) {
  const formatted = formatInstant(
    date.toISOString(),
    getGlobalTimeZoneSetting(),
  );
  return formatted ? formatted.slice(5, 16) : "-";
}

function parseMaybeJson<T>(text: string) {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function objectFrom(value: unknown): RawObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawObject)
    : null;
}

function arrayFrom(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

function cleanString(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function numberPtr(value: unknown) {
  return isNumberish(value) ? numberFromAny(value) : null;
}

function numberFromAny(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim().replace(/%$/, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isNumberish(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  return Number.isFinite(Number.parseFloat(value.trim().replace(/%$/, "")));
}

function booleanFromAny(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function normalizeMaybeDate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(
      value > 10_000_000_000 ? value : value * 1000,
    ).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }
  return null;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

function reportToRecord(report: CodexQuotaReport): Record<string, unknown> {
  return { ...report };
}

function removeRaw(report: Record<string, unknown>) {
  const rest = { ...report };
  delete rest.raw;
  return rest;
}
