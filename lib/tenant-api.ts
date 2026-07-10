import type {
  AdminOverviewStats,
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
  TenantResources,
} from "@/src/shared/types/entities";
import type {
  AdminApiErrorBody,
  AdminDashboardRequestLogRow,
  AdminDeleteResponse,
  ApiKeyPayload,
  CodexQuotaReport,
  CodexResetCreditsReport,
  CredentialProxyPayload,
  RequestLogDetail,
  RequestLogsPage,
  RequestLogStatusFilter,
} from "@/lib/admin-api";
import { AdminApiError } from "@/lib/admin-api";

export const TENANT_AUTH_EXPIRED_EVENT = "relayapi:tenant-auth-expired";

let tenantAuthExpiredNotified = false;

type TenantRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
};

export async function tenantRequest<T>(
  url: string,
  init: TenantRequestInit = {},
): Promise<T> {
  const { body, headers, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    credentials: rest.credentials ?? "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await parseResponseBody(response);
  if (!response.ok) {
    const error = toTenantApiError(response, parsed);
    notifyTenantAuthExpired(error);
    throw error;
  }
  return parsed as T;
}

export function loginTenant(payload: { email: string; password: string }) {
  return tenantRequest<{ authenticated: true }>("/api/tenant/auth/login", {
    method: "POST",
    body: payload,
  });
}

export function activateTenant(payload: {
  token: string;
  email: string;
  password: string;
  displayName: string;
}) {
  return tenantRequest<{ activated: true }>("/api/tenant/auth/activate", {
    method: "POST",
    body: payload,
  });
}

export function logoutTenantSession() {
  return tenantRequest<{ authenticated: false }>("/api/tenant/auth/logout", {
    method: "POST",
  });
}

export function changeTenantPassword(payload: { currentPassword: string; newPassword: string }) {
  return tenantRequest<{ changed: true }>("/api/tenant/auth/password", { method: "POST", body: payload });
}

export function resetTenantPassword(payload: { token: string; password: string }) {
  return tenantRequest<{ reset: true }>("/api/tenant/auth/reset-password", { method: "POST", body: payload });
}

export async function listTenantApiKeys() {
  const result = await tenantRequest<{ object: "list"; data: PublicApiKey[] }>(
    "/api/tenant/api-keys",
  );
  return result.data;
}

export function createTenantApiKey(payload: ApiKeyPayload = {}) {
  return tenantRequest<CreatedApiKey>("/api/tenant/api-keys", {
    method: "POST",
    body: payload,
  });
}

export function updateTenantApiKey(id: string, payload: ApiKeyPayload) {
  return tenantRequest<PublicApiKey>(
    `/api/tenant/api-keys/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export function deleteTenantApiKey(id: string) {
  return tenantRequest<AdminDeleteResponse>(
    `/api/tenant/api-keys/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export function getTenantOverview() {
  return tenantRequest<AdminOverviewStats>("/api/tenant/overview");
}

export type TenantQuotaReport = {
  tenantId: string;
  shares: number | null;
  windows: Partial<Record<"5h" | "7d", {
    kind: "5h" | "7d";
    startedAt: string;
    resetsAt: string;
    limitNanoUsd: string;
    settledNanoUsd: string;
    reservedNanoUsd: string;
  }>>;
};

export function getTenantQuota() {
  return tenantRequest<TenantQuotaReport>("/api/tenant/quota");
}

export function getTenantCostAnalysis() {
  return tenantRequest<import("@/lib/admin-api").CostAnalysis>(
    "/api/tenant/cost-analysis",
  );
}

export function getTenantResources() {
  return tenantRequest<TenantResources>("/api/tenant/resources");
}

export function getTenantSettings() {
  return tenantRequest<PublicTenant>("/api/tenant/settings");
}

export function updateTenantSettings(payload: {
  proxy?: CredentialProxyPayload;
  userAgent?: string | null;
}) {
  return tenantRequest<PublicTenant>("/api/tenant/settings", {
    method: "PATCH",
    body: payload,
  });
}

export function getTenantRequestLogsPage(
  options: {
    limit?: number;
    page?: number;
    query?: string;
    status?: RequestLogStatusFilter;
  } = {},
) {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    page: String(options.page ?? 1),
  });
  if (options.query?.trim()) {
    params.set("query", options.query.trim());
  }
  if (options.status && options.status !== "all") {
    params.set("status", options.status);
  }
  return tenantRequest<RequestLogsPage>(
    `/api/tenant/request-logs?${params.toString()}`,
  );
}

export function getTenantRequestLogDetail(id: string) {
  return tenantRequest<RequestLogDetail>(
    `/api/tenant/request-logs/${encodeURIComponent(id)}`,
  );
}

export function getTenantCredentialQuota(
  id: string,
  options: { refresh?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.refresh) {
    params.set("refresh", "1");
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  return tenantRequest<CodexQuotaReport>(
    `/api/tenant/codex/credentials/${encodeURIComponent(id)}/quota${suffix}`,
  );
}

export function getTenantCredentialResetCredits(
  id: string,
  options: { raw?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.raw) {
    params.set("raw", "1");
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  return tenantRequest<CodexResetCreditsReport>(
    `/api/tenant/codex/credentials/${encodeURIComponent(id)}/quota/reset-credits${suffix}`,
  );
}

export type TenantDashboardSnapshot = {
  tenant: PublicTenant;
  resources: TenantResources;
  apiKeys: PublicApiKey[];
  overviewStats: AdminOverviewStats;
  requestLogs: AdminDashboardRequestLogRow[];
};

export function tenantErrorMessage(error: unknown) {
  if (isTenantAuthError(error)) {
    return "租户会话已过期，请重新登录";
  }
  if (error instanceof AdminApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isTenantAuthError(error: unknown) {
  return error instanceof AdminApiError && error.code === "tenant_auth_required";
}

function notifyTenantAuthExpired(error: unknown) {
  if (
    !isTenantAuthError(error) ||
    tenantAuthExpiredNotified ||
    typeof window === "undefined"
  ) {
    return;
  }
  tenantAuthExpiredNotified = true;
  window.dispatchEvent(
    new CustomEvent(TENANT_AUTH_EXPIRED_EVENT, {
      detail: { message: tenantErrorMessage(error) },
    }),
  );
}

async function parseResponseBody(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      return text;
    }
    return { message: text } satisfies AdminApiErrorBody;
  }
}

function toTenantApiError(response: Response, parsed: unknown) {
  const body = isObject(parsed) ? (parsed as AdminApiErrorBody) : null;
  const error = isObject(body?.error) ? body.error : null;
  const fallbackCode =
    response.status === 401
      ? "tenant_auth_required"
      : response.status || "request_failed";
  return new AdminApiError({
    status: response.status,
    code: String(error?.code || fallbackCode),
    message: String(
      error?.message ||
        body?.message ||
        response.statusText ||
        "Request failed",
    ),
    details: error?.details,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
