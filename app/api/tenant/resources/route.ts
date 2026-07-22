import { errorToResponse } from "@/src/server/http/errors";
import {
  getTenantResources,
  requireTenantRequest,
} from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    return Response.json(await getTenantResources(context.tenant, context.user.id));
  } catch (error) {
    return errorToResponse(error);
  }
}
