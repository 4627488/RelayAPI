import "server-only";

import { proxiedFetch } from "@/src/server/net/proxy";
import { ensureFreshGrokCredential, forceRefreshGrokCredential } from "@/src/server/services/grokCredentials";
import { resolveCredentialProxy } from "@/src/server/services/codexCredentials";
import { HttpError } from "@/src/server/http/errors";

const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLIENT_VERSION = "0.2.93";

export type GrokQuotaWindow = { usedPercent: number | null; remainingPercent: number | null; resetsAt: string | null; label: string };
export type GrokQuotaReport = { status: "available" | "partial" | "unavailable"; fetchedAt: string; weekly: GrokQuotaWindow | null; monthly: GrokQuotaWindow | null; rateLimit: GrokQuotaWindow | null };

export async function getGrokQuota(id: string): Promise<GrokQuotaReport> {
  let credential = await ensureFreshGrokCredential(id);
  if (credential.authType !== "oauth") throw new HttpError(400, "grok_quota_oauth_required", "Upstream quota is only available for Grok OAuth subscriptions");
  const proxy = resolveCredentialProxy({ proxy: credential.proxy, proxyPoolId: credential.proxyPoolId, useGlobalProxy: credential.useGlobalProxy, tenantProxy: null });
  const baseUrl = text(credential.grokBaseUrl) || GROK_CLI_BASE_URL;
  const request = async (path: string) => proxiedFetch(`${baseUrl}${path}`, { method: "GET", headers: billingHeaders(credential.tokens.access_token), signal: AbortSignal.timeout(20_000) }, proxy);
  let [weeklyResponse, monthlyResponse] = await Promise.all([request("/billing?format=credits"), request("/billing")]);
  if ((weeklyResponse.status === 401 || monthlyResponse.status === 401) && credential.tokens.refresh_token) {
    await Promise.all([weeklyResponse.body?.cancel().catch(() => undefined), monthlyResponse.body?.cancel().catch(() => undefined)]);
    credential = await forceRefreshGrokCredential(id);
    [weeklyResponse, monthlyResponse] = await Promise.all([request("/billing?format=credits"), request("/billing")]);
  }
  const weekly = weeklyResponse.ok ? parseGrokBillingPayload(await weeklyResponse.json(), "weekly") : null;
  const monthly = monthlyResponse.ok ? parseGrokBillingPayload(await monthlyResponse.json(), "monthly") : null;
  if (!weekly && !monthly) throw new HttpError(502, "grok_quota_upstream_error", `Grok billing request failed (${weeklyResponse.status}/${monthlyResponse.status})`);
  let rateLimit: GrokQuotaWindow | null = null;
  if (weekly?.usedPercent === null && monthly?.usedPercent === null) {
    const probe = await proxiedFetch(`${baseUrl}/responses`, { method: "POST", headers: { ...billingHeaders(credential.tokens.access_token), Accept: "text/event-stream" }, body: JSON.stringify({ model: "grok-4.5", input: "hi", stream: true }), signal: AbortSignal.timeout(20_000) }, proxy);
    rateLimit = parseGrokRateLimitHeaders(probe.headers);
    await probe.body?.cancel().catch(() => undefined);
  }
  return { status: weekly && monthly ? "available" : "partial", fetchedAt: new Date().toISOString(), weekly, monthly, rateLimit };
}

export function parseGrokBillingPayload(payload: unknown, kind: "weekly" | "monthly"): GrokQuotaWindow | null {
  const config = record(record(payload)?.config);
  if (!config) return null;
  const period = record(config.currentPeriod);
  const resetsAt = text(period?.end) || text(config.billingPeriodEnd);
  const usedPercent = kind === "weekly" ? number(config.creditUsagePercent) : percent(numberish(config.used), numberish(config.monthlyLimit));
  const normalized = usedPercent === null ? null : Math.max(0, Math.min(100, usedPercent));
  return { usedPercent: normalized, remainingPercent: normalized === null ? null : 100 - normalized, resetsAt, label: kind === "weekly" ? "Weekly" : "Monthly" };
}

export function parseGrokRateLimitHeaders(headers: Headers): GrokQuotaWindow | null {
  const limit = number(headers.get("x-ratelimit-limit-tokens"));
  const remaining = number(headers.get("x-ratelimit-remaining-tokens"));
  if (limit === null && remaining === null) return null;
  const remainingPercent = limit !== null && limit > 0 && remaining !== null ? Math.max(0, Math.min(100, remaining / limit * 100)) : null;
  const reset = headers.get("x-ratelimit-reset-tokens");
  const resetNumber = number(reset);
  const resetsAt = resetNumber !== null ? new Date(resetNumber > 1_000_000_000_000 ? resetNumber : resetNumber * 1000).toISOString() : text(reset);
  return { usedPercent: remainingPercent === null ? null : 100 - remainingPercent, remainingPercent, resetsAt, label: "Rolling 24h" };
}

function billingHeaders(token: string) { return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "X-XAI-Token-Auth": "xai-grok-cli", "X-Grok-Client-Version": GROK_CLIENT_VERSION, "User-Agent": `grok-pager/${GROK_CLIENT_VERSION} grok-shell/${GROK_CLIENT_VERSION} (macos; aarch64)` }; }
function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function numberish(value: unknown): number | null { const object = record(value); return number(object?.val ?? value); }
function percent(used: number | null, limit: number | null) { return used !== null && limit !== null && limit > 0 ? used / limit * 100 : null; }
