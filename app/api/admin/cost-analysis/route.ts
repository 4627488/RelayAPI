import { errorToResponse } from "@/src/server/http/errors";
import { getCostAnalysis } from "@/src/server/repositories/logs";
import { attachConfiguredModelPrices } from "@/src/server/services/quotaAdministration";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    requireWebRequest(request);
    const tenantId = new URL(request.url).searchParams.get("tenantId");
    return Response.json(attachConfiguredModelPrices(getCostAnalysis(tenantId ? { tenantId } : {})));
  } catch (error) {
    return errorToResponse(error);
  }
}
