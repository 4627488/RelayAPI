import { errorToResponse } from "@/src/server/http/errors";
import { getCostAnalysis } from "@/src/server/repositories/logs";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    return Response.json(getCostAnalysis({ tenantId: context.tenant.id }));
  } catch (error) {
    return errorToResponse(error);
  }
}
