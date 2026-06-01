import { errorToResponse } from "@/src/server/http/errors";
import {
  patchTenantApiKey,
  removeTenantApiKey,
} from "@/src/server/services/apiKeys";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = requireTenantRequest(request);
    const { id } = await context.params;
    const body = await request.json();
    return Response.json(patchTenantApiKey(session.tenant, id, body));
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = requireTenantRequest(request);
    const { id } = await context.params;
    removeTenantApiKey(session.tenant.id, id);
    return Response.json({ id, deleted: true });
  } catch (error) {
    return errorToResponse(error);
  }
}
