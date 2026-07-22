import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { proxiedFetch } from "@/src/server/net/proxy";
import { updateGrokCredential } from "@/src/server/repositories/grokCredentials";
import { resolveCredentialProxy } from "@/src/server/services/codexCredentials";
import { ensureFreshGrokCredential, forceRefreshGrokCredential } from "@/src/server/services/grokCredentials";
import { recordCodexQuotaObservation } from "@/src/server/services/quotaCalibration";

const DEFAULT_GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLI_VERSION = "0.2.93";

export type GrokQuotaWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  label: string;
};
export type GrokQuotaReport = {
  status: "available" | "partial" | "unavailable";
  fetchedAt: string;
  planType: string | null;
  weekly: GrokQuotaWindow | null;
  monthly: GrokQuotaWindow | null;
  productUsage: GrokQuotaWindow[];
  rateLimit: GrokQuotaWindow | null;
};

type BillingConfig = {
  currentPeriod?: { type?: unknown; start?: unknown; end?: unknown };
  creditUsagePercent?: unknown;
  productUsage?: Array<{ product?: unknown; usagePercent?: unknown }>;
  monthlyLimit?: unknown;
  used?: unknown;
  billingPeriodStart?: unknown;
  billingPeriodEnd?: unknown;
};

export async function getGrokQuota(id: string): Promise<GrokQuotaReport> {
  let credential = await ensureFreshGrokCredential(id);
  if (credential.authType !== "oauth") throw new HttpError(400, "grok_quota_oauth_required", "Upstream quota is only available for Grok OAuth subscriptions");
  const proxy = resolveCredentialProxy({ proxy: credential.proxy, proxyPoolId: credential.proxyPoolId, useGlobalProxy: credential.useGlobalProxy, tenantProxy: null });
  const base = (credential.grokBaseUrl || DEFAULT_GROK_CLI_BASE_URL).replace(/\/+$/, "");
  const fetchBilling = (path: string) => proxiedFetch(`${base}${path}`, {
    headers: billingHeaders(credential.tokens.access_token),
    signal: AbortSignal.timeout(20_000),
  }, proxy);
  let responses = await Promise.allSettled([fetchBilling("/billing?format=credits"), fetchBilling("/billing")]);
  if (responses.some((result) => result.status === "fulfilled" && (result.value.status === 401 || result.value.status === 403)) && credential.tokens.refresh_token) {
    for (const result of responses) if (result.status === "fulfilled") await result.value.body?.cancel().catch(() => undefined);
    credential = await forceRefreshGrokCredential(id);
    responses = await Promise.allSettled([fetchBilling("/billing?format=credits"), fetchBilling("/billing")]);
  }
  const parsed = await Promise.all(responses.map(readBillingResponse));
  const successful = parsed.filter((item) => item.ok);
  if (!successful.length) {
    const statuses = parsed.map((item) => item.status || "network").join(", ");
    throw new HttpError(502, "grok_quota_upstream_error", `Grok billing request failed (${statuses})`);
  }
  const weeklyConfig = parsed[0].config;
  const monthlyConfig = parsed[1].config;
  const weekly = weeklyConfig ? weeklyWindow(weeklyConfig) : null;
  const monthly = monthlyConfig ? monthlyWindow(monthlyConfig) : null;
  const productUsage = weeklyConfig ? productWindows(weeklyConfig) : [];
  const planType = detectPlan(monthlyConfig);
  if (planType && planType !== credential.planType) updateGrokCredential(id, { planType });
  if (weekly) {
    recordCodexQuotaObservation({
      credentialId: credential.id,
      planType: planType || credential.planType,
      observedAt: new Date().toISOString(),
      windows: [{ kind: "7d", usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt }],
    });
  }
  return {
    status: successful.length === 2 ? "available" : "partial",
    fetchedAt: new Date().toISOString(),
    planType,
    weekly,
    monthly,
    productUsage,
    rateLimit: null,
  };
}

export function parseGrokBillingPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const config = (payload as { config?: unknown }).config;
  return config && typeof config === "object" && !Array.isArray(config) ? config as BillingConfig : null;
}

function weeklyWindow(config: BillingConfig): GrokQuotaWindow | null {
  const usedPercent = percent(config.creditUsagePercent);
  const period = config.currentPeriod;
  const weekly = typeof period?.type === "string" && period.type.toLowerCase().includes("weekly");
  if (usedPercent === null && !weekly && !config.productUsage?.length) return null;
  return quotaWindow("7d", usedPercent, text(period?.end));
}

function monthlyWindow(config: BillingConfig): GrokQuotaWindow | null {
  const limit = centValue(config.monthlyLimit);
  const used = centValue(config.used);
  if (limit === null && used === null && !text(config.billingPeriodEnd)) return null;
  const usedPercent = limit !== null && limit > 0 && used !== null ? Math.min(100, used / limit * 100) : null;
  return quotaWindow("Monthly", usedPercent, text(config.billingPeriodEnd));
}

function productWindows(config: BillingConfig) {
  return (config.productUsage || []).flatMap((item) => {
    const label = text(item.product);
    return label ? [quotaWindow(label, percent(item.usagePercent), text(config.currentPeriod?.end))] : [];
  });
}

function quotaWindow(label: string, usedPercent: number | null, resetsAt: string | null): GrokQuotaWindow {
  const normalized = usedPercent === null ? null : Math.max(0, Math.min(100, usedPercent));
  return { label, usedPercent: normalized, remainingPercent: normalized === null ? null : 100 - normalized, resetsAt };
}

function detectPlan(config: BillingConfig | null) {
  const limit = centValue(config?.monthlyLimit);
  if (limit === null) return null;
  if (Math.round(limit) === 150_000) return "supergrok-heavy";
  if (Math.round(limit) === 15_000) return "supergrok";
  if (limit === 0) return "free";
  return null;
}

async function readBillingResponse(result: PromiseSettledResult<Response>): Promise<{ ok: boolean; status: number | null; config: BillingConfig | null }> {
  if (result.status === "rejected") return { ok: false, status: null, config: null };
  const response = result.value;
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { ok: false, status: response.status, config: null }; }
  try { return { ok: true, status: response.status, config: parseGrokBillingPayload(await response.json()) }; }
  catch { return { ok: false, status: response.status, config: null }; }
}

function billingHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "X-Grok-Client-Version": GROK_CLI_VERSION,
    "User-Agent": `grok-pager/${GROK_CLI_VERSION} grok-shell/${GROK_CLI_VERSION} (macos; aarch64)`,
  };
}

function centValue(value: unknown): number | null {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as { val?: unknown }).val : value;
  const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(number) ? number : null;
}
function percent(value: unknown) { const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN; return Number.isFinite(number) ? number : null; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
