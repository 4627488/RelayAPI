import { errorToResponse } from "@/src/server/http/errors";
import { revokeTenantSessions } from "@/src/server/services/tenants";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    revokeTenantSessions(id);
    return Response.json({ revoked: true });
  } catch (error) { return errorToResponse(error); }
}
