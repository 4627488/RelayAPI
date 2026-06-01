import { errorToResponse } from "@/src/server/http/errors";
import {
  requireTenantRequest,
  toPublicTenant,
} from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    return Response.json({
      tenant: toPublicTenant(context.tenant),
      user: {
        id: context.user.id,
        email: context.user.email,
        displayName: context.user.displayName,
        role: context.user.role,
      },
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
