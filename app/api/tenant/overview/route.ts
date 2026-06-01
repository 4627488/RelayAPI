import { errorToResponse } from "@/src/server/http/errors";
import { getAdminOverviewStats } from "@/src/server/repositories/logs";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    return Response.json(
      getAdminOverviewStats({ tenantId: context.tenant.id }),
    );
  } catch (error) {
    return errorToResponse(error);
  }
}
