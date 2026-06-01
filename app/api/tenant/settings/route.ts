import { errorToResponse } from "@/src/server/http/errors";
import {
  patchTenantSettings,
  requireTenantRequest,
  toPublicTenant,
} from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    return Response.json(toPublicTenant(context.tenant));
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = requireTenantRequest(request);
    const body = await request.json();
    return Response.json(patchTenantSettings(context, body));
  } catch (error) {
    return errorToResponse(error);
  }
}
