import { errorToResponse } from "@/src/server/http/errors";
import { getAdminOverviewStats } from "@/src/server/repositories/logs";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Overview returns aggregate request, token, cost, and performance metadata.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    const searchParams = new URL(request.url).searchParams;
    return Response.json(
      getAdminOverviewStats({
        days: normalizeDays(searchParams.get("days")),
      }),
    );
  } catch (error) {
    return errorToResponse(error);
  }
}

function normalizeDays(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
