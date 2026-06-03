import { errorToResponse } from "@/src/server/http/errors";
import { transferAdminApiKeyToTenant } from "@/src/server/services/apiKeys";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    const body = await request.json();
    return Response.json(transferAdminApiKeyToTenant(id, body));
  } catch (error) {
    return errorToResponse(error);
  }
}
