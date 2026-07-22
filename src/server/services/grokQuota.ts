import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { proxiedFetch } from "@/src/server/net/proxy";
import { resolveCredentialProxy } from "@/src/server/services/codexCredentials";
import { ensureFreshGrokCredential, forceRefreshGrokCredential } from "@/src/server/services/grokCredentials";

const GROK_BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

export type GrokQuotaWindow = { usedPercent: number | null; remainingPercent: number | null; resetsAt: string | null; label: string };
export type GrokQuotaReport = { status: "available" | "partial" | "unavailable"; fetchedAt: string; weekly: GrokQuotaWindow | null; monthly: GrokQuotaWindow | null; rateLimit: GrokQuotaWindow | null };

export async function getGrokQuota(id: string): Promise<GrokQuotaReport> {
  let credential = await ensureFreshGrokCredential(id);
  if (credential.authType !== "oauth") throw new HttpError(400, "grok_quota_oauth_required", "Upstream quota is only available for Grok OAuth subscriptions");
  const proxy = resolveCredentialProxy({ proxy: credential.proxy, proxyPoolId: credential.proxyPoolId, useGlobalProxy: credential.useGlobalProxy, tenantProxy: null });
  const request = () => proxiedFetch(GROK_BILLING_URL, {
    method: "POST",
    headers: billingHeaders(credential.tokens.access_token),
    body: new Uint8Array([0, 0, 0, 0, 0]),
    signal: AbortSignal.timeout(20_000),
  }, proxy);
  let response = await request();
  if ((response.status === 401 || response.status === 403) && credential.tokens.refresh_token) {
    await response.body?.cancel().catch(() => undefined);
    credential = await forceRefreshGrokCredential(id);
    response = await request();
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) throw new HttpError(502, "grok_quota_upstream_error", `Grok billing request failed (${response.status})`);
  assertGrpcSuccess(response.headers, bytes);
  const monthly = parseGrokBillingPayload(bytes);
  if (!monthly) throw new HttpError(502, "grok_quota_invalid_response", "Grok billing response did not contain a usable credits window");
  return { status: "available", fetchedAt: new Date().toISOString(), weekly: null, monthly, rateLimit: null };
}

export function parseGrokBillingPayload(payload: Uint8Array, now = new Date()): GrokQuotaWindow | null {
  const scan: ProtoScan = { fixed32: [], varints: [] };
  for (const frame of grpcDataFrames(payload)) scanProto(frame, [], 0, scan);
  const usageCandidates = scan.fixed32.filter((field) => field.path.at(-1) === 1 && field.value >= 0 && field.value <= 100);
  const preferredUsage = usageCandidates.find((field) => samePath(field.path, [1, 1])) || usageCandidates[0];
  const resetCandidates = scan.varints
    .filter((field) => field.value >= 1_700_000_000n && field.value <= 2_100_000_000n && Number(field.value) * 1000 > now.getTime())
    .sort((left, right) => Number(left.value - right.value));
  const preferredReset = resetCandidates.find((field) => samePath(field.path, [1, 5, 1])) || resetCandidates[0];
  const emptyWindow = !scan.fixed32.length && Boolean(preferredReset) && scan.varints.some((field) => field.path[0] === 1 && field.path[1] === 6);
  const usedPercent = preferredUsage?.value ?? (emptyWindow ? 0 : null);
  if (usedPercent === null) return null;
  const normalized = Math.max(0, Math.min(100, usedPercent));
  return { usedPercent: normalized, remainingPercent: 100 - normalized, resetsAt: preferredReset ? new Date(Number(preferredReset.value) * 1000).toISOString() : null, label: "Monthly" };
}

function billingHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "*/*", "Content-Type": "application/grpc-web+proto", Origin: "https://grok.com", Referer: "https://grok.com/?_s=usage", "x-grpc-web": "1", "x-user-agent": "connect-es/2.1.1" };
}

type ProtoField<T> = { path: number[]; value: T };
type ProtoScan = { fixed32: ProtoField<number>[]; varints: ProtoField<bigint>[] };

function grpcDataFrames(bytes: Uint8Array) {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset + 5 <= bytes.length;) {
    const flags = bytes[offset];
    const length = readU32(bytes, offset + 1);
    const end = offset + 5 + length;
    if (end > bytes.length) break;
    if ((flags & 0x80) === 0) frames.push(bytes.subarray(offset + 5, end));
    offset = end;
  }
  return frames;
}

function scanProto(bytes: Uint8Array, path: number[], depth: number, scan: ProtoScan) {
  if (depth > 12) return;
  for (let offset = 0; offset < bytes.length;) {
    const key = readVarint(bytes, offset); if (!key) return; offset = key.next;
    const field = Number(key.value >> 3n); const wire = Number(key.value & 7n); const fieldPath = [...path, field];
    if (!field) return;
    if (wire === 0) { const value = readVarint(bytes, offset); if (!value) return; scan.varints.push({ path: fieldPath, value: value.value }); offset = value.next; continue; }
    if (wire === 5) { if (offset + 4 > bytes.length) return; scan.fixed32.push({ path: fieldPath, value: new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true) }); offset += 4; continue; }
    if (wire === 1) { offset += 8; if (offset > bytes.length) return; continue; }
    if (wire === 2) { const size = readVarint(bytes, offset); if (!size) return; offset = size.next; const end = offset + Number(size.value); if (end > bytes.length) return; scanProto(bytes.subarray(offset, end), fieldPath, depth + 1, scan); offset = end; continue; }
    return;
  }
}

function assertGrpcSuccess(headers: Headers, bytes: Uint8Array) {
  const headerStatus = headers.get("grpc-status");
  const trailers = grpcTrailerFields(bytes);
  const status = headerStatus || trailers.get("grpc-status");
  if (status && status !== "0") throw new HttpError(502, "grok_quota_grpc_error", `Grok billing gRPC request failed (${status})`);
}

function grpcTrailerFields(bytes: Uint8Array) {
  const result = new Map<string, string>();
  for (let offset = 0; offset + 5 <= bytes.length;) {
    const flags = bytes[offset]; const length = readU32(bytes, offset + 1); const end = offset + 5 + length; if (end > bytes.length) break;
    if ((flags & 0x80) !== 0) for (const line of new TextDecoder().decode(bytes.subarray(offset + 5, end)).split(/\r?\n/)) { const colon = line.indexOf(":"); if (colon > 0) result.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()); }
    offset = end;
  }
  return result;
}

function readVarint(bytes: Uint8Array, start: number) { let value = 0n; let shift = 0n; for (let index = start; index < bytes.length && shift < 70n; index++, shift += 7n) { const byte = bytes[index]; value |= BigInt(byte & 0x7f) << shift; if ((byte & 0x80) === 0) return { value, next: index + 1 }; } return null; }
function readU32(bytes: Uint8Array, offset: number) { return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false); }
function samePath(left: number[], right: number[]) { return left.length === right.length && left.every((value, index) => value === right[index]); }
