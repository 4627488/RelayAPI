import { errorToResponse, HttpError } from "@/src/server/http/errors";
import { getRequestLogDetail } from "@/src/server/repositories/logs";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = requireTenantRequest(request);
    const { id } = await context.params;
    const detail = getRequestLogDetail(id, { tenantId: session.tenant.id });
    if (!detail) {
      throw new HttpError(404, "request_log_not_found", "Request log not found");
    }
    return Response.json(detail);
  } catch (error) {
    return errorToResponse(error);
  }
}
