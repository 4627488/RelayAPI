import { errorToResponse } from "@/src/server/http/errors";
import {
  queryRequestLogs,
  type RequestLogStatusFilter,
} from "@/src/server/repositories/logs";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    const searchParams = new URL(request.url).searchParams;
    const limit = normalizeLimit(searchParams.get("limit"));
    const page = normalizePage(searchParams.get("page"));
    const query = searchParams.get("query") || searchParams.get("q") || "";
    const status = normalizeStatus(searchParams.get("status"));
    const result = queryRequestLogs({
      tenantId: context.tenant.id,
      limit,
      offset: (page - 1) * limit,
      query,
      status,
      method: searchParams.get("method") || undefined,
      model: searchParams.get("model") || undefined,
      from: normalizeDate(searchParams.get("from")),
      to: normalizeDate(searchParams.get("to")),
      minLatencyMs: normalizePositiveNumber(searchParams.get("minLatencyMs")),
      includeSummary: searchParams.get("summary") === "full",
    });
    return Response.json({
      object: "list",
      data: result.data,
      limit: result.limit,
      page,
      offset: result.offset,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
      summary: {
        errorCount: result.errorCount,
        totalTokens: result.totalTokens,
        cachedTokens: result.cachedTokens,
        cacheHitRate: result.cacheHitRate,
        avgLatencyMs: result.avgLatencyMs,
      },
    });
  } catch (error) {
    return errorToResponse(error);
  }
}

function normalizeDate(value: string | null) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizePositiveNumber(value: string | null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeLimit(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function normalizePage(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeStatus(value: string | null): RequestLogStatusFilter {
  if (
    value === "success" ||
    value === "error" ||
    value === "stream" ||
    value === "all"
  ) {
    return value;
  }
  return "all";
}
