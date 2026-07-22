import { errorToResponse } from "@/src/server/http/errors";
import { patchCredentialQuotaEstimates } from "@/src/server/services/tenantSubscriptions";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    return Response.json(patchCredentialQuotaEstimates(id, await request.json() as Record<string, unknown>));
  } catch (error) {
    return errorToResponse(error);
  }
}
