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
  CredentialProxyPayload,
  RequestLogDetail,
  RequestLogsPage,
  RequestLogFilters,
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
  return tenantRequest<{ authenticated: true; role: "tenant" }>("/api/auth/login", {
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
  return tenantRequest<{ authenticated: false }>("/api/auth/logout", {
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

export function getTenantOverview(options: { days?: number } = {}) {
  const params = new URLSearchParams();
  if (options.days) params.set("days", String(options.days));
  const suffix = params.size ? `?${params.toString()}` : "";
  return tenantRequest<AdminOverviewStats>(`/api/tenant/overview${suffix}`);
}

export type TenantQuotaReport = {
  tenantId: string;
  subscriptions: Array<{
    id: string; name: string; units: number; unitsPerCredential: number;
    enabled: boolean; startsAt: string; expiresAt: string | null;
    windows: Partial<Record<"5h" | "7d", {
      kind: "5h" | "7d"; startedAt: string; resetsAt: string;
      limitNanoUsd: string; settledNanoUsd: string; reservedNanoUsd: string;
    }>>;
  }>;
};

export function getTenantQuota() {
  return tenantRequest<TenantQuotaReport>("/api/tenant/quota");
}

export function getTenantSubscriptionResetEvents(id: string) {
  return tenantRequest<{
    subscription: { id: string; name: string };
    events: import("@/lib/admin-api").CredentialQuotaResetEvent[];
  }>(`/api/tenant/subscriptions/${encodeURIComponent(id)}/reset-events`);
}

export function getTenantCostAnalysis(subscriptionId: string) {
  return tenantRequest<import("@/lib/admin-api").CostAnalysis>(
    `/api/tenant/cost-analysis?subscriptionId=${encodeURIComponent(subscriptionId)}`,
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
  options: RequestLogFilters = {},
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
  for (const key of ["method", "model", "from", "to"] as const) {
    if (options[key]) params.set(key, options[key]);
  }
  if (options.minLatencyMs) params.set("minLatencyMs", String(options.minLatencyMs));
  return tenantRequest<RequestLogsPage>(
    `/api/tenant/request-logs?${params.toString()}`,
  );
}

export function getTenantRequestLogDetail(id: string) {
  return tenantRequest<RequestLogDetail>(
    `/api/tenant/request-logs/${encodeURIComponent(id)}`,
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
