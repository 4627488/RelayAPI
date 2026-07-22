import "server-only";

import { HttpError } from "@/src/server/http/errors";

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type GrokDeviceSession = {
  id: string; deviceCode: string; userCode: string; verificationUri: string;
  verificationUriComplete: string; tokenEndpoint: string; interval: number; expiresAt: number;
};

export async function startGrokDeviceFlow(id: string): Promise<GrokDeviceSession> {
  const discovery = await jsonFetch(DISCOVERY_URL);
  const deviceEndpoint = safeXaiUrl(stringValue(discovery.device_authorization_endpoint));
  const tokenEndpoint = safeXaiUrl(stringValue(discovery.token_endpoint));
  const payload = await formFetch(deviceEndpoint, { client_id: CLIENT_ID, scope: SCOPE });
  const expiresIn = numberValue(payload.expires_in) || 1800;
  return { id, deviceCode: stringValue(payload.device_code), userCode: stringValue(payload.user_code),
    verificationUri: stringValue(payload.verification_uri), verificationUriComplete: stringValue(payload.verification_uri_complete),
    tokenEndpoint, interval: Math.max(5, numberValue(payload.interval) || 5), expiresAt: Date.now() + expiresIn * 1000 };
}

export async function pollGrokDeviceFlow(session: GrokDeviceSession) {
  if (Date.now() >= session.expiresAt) throw new HttpError(410, "grok_device_code_expired", "Grok device code expired");
  const response = await fetch(session.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: session.deviceCode, client_id: CLIENT_ID }) });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const error = stringValue(payload.error);
  if (error === "authorization_pending" || error === "slow_down") return null;
  if (!response.ok || error) throw new HttpError(400, "grok_oauth_error", stringValue(payload.error_description) || error || `Grok OAuth failed (${response.status})`);
  return tokenBundle(payload, session.tokenEndpoint);
}

export async function refreshGrokTokens(refreshToken: string, tokenEndpoint: string) {
  const payload = await formFetch(safeXaiUrl(tokenEndpoint), { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken });
  return tokenBundle(payload, tokenEndpoint);
}

function tokenBundle(payload: Record<string, unknown>, tokenEndpoint: string) {
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) throw new HttpError(502, "grok_oauth_invalid_response", "Grok OAuth response is missing access_token");
  const expiresIn = numberValue(payload.expires_in);
  return { access_token: accessToken, refresh_token: stringValue(payload.refresh_token), id_token: stringValue(payload.id_token),
    token_type: stringValue(payload.token_type) || "Bearer", expired: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : "",
    token_endpoint: tokenEndpoint, api_key: "", plan_type: grokPlanType(payload) };
}

export function grokJwtIdentity(idToken: string) {
  try { const payload = idToken.split(".")[1]; const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return { email: stringValue(parsed.email), subject: stringValue(parsed.sub) }; } catch { return { email: "", subject: "" }; }
}

export function grokPlanType(payload: Record<string, unknown>) {
  const direct = [payload.plan_type, payload.planType, payload.subscription_tier, payload.subscriptionTier, payload.auth_mode]
    .map(stringValue).find(Boolean);
  if (direct) return normalizeGrokPlan(direct);
  for (const token of [stringValue(payload.id_token), stringValue(payload.access_token)]) {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
      const nested = findPlanClaim(claims);
      if (nested) return normalizeGrokPlan(nested);
    } catch { /* An opaque token carries no locally readable plan. */ }
  }
  return "supergrok";
}

function findPlanClaim(value: unknown, depth = 0): string {
  if (!value || typeof value !== "object" || depth > 4) return "";
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(plan|plan_type|subscription|subscription_tier|tier|auth_mode)$/i.test(key)) {
      const found = stringValue(child); if (found) return found;
    }
  }
  for (const child of Object.values(value as Record<string, unknown>)) { const found = findPlanClaim(child, depth + 1); if (found) return found; }
  return "";
}

function normalizeGrokPlan(value: string) { return value.trim().toLowerCase().replace(/[\s_]+/g, "-"); }

async function jsonFetch(url: string) { const response = await fetch(url, { headers: { Accept: "application/json" } }); if (!response.ok) throw new HttpError(502, "grok_oauth_discovery_failed", `Grok OAuth discovery failed (${response.status})`); return await response.json() as Record<string, unknown>; }
async function formFetch(url: string, values: Record<string, string>) { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(values) }); const payload = await response.json().catch(() => ({})) as Record<string, unknown>; if (!response.ok) throw new HttpError(502, "grok_oauth_request_failed", stringValue(payload.error_description) || stringValue(payload.error) || `Grok OAuth request failed (${response.status})`); return payload; }
function safeXaiUrl(raw: string) { const url = new URL(raw); const host = url.hostname.toLowerCase(); if (url.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) throw new HttpError(502, "grok_oauth_unsafe_endpoint", "Grok OAuth returned an unsafe endpoint"); return url.toString(); }
function stringValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function numberValue(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
