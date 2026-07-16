import { errorToResponse } from "@/src/server/http/errors";
import { listCredentialQuotaResetEvents } from "@/src/server/repositories/credentialQuotaResetEvents";
import { getCodexCredentialById } from "@/src/server/repositories/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/admin/codex/credentials/[id]/quota/reset-events">) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    const credential = getCodexCredentialById(id);
    if (!credential) return Response.json({ error: "Credential not found" }, { status: 404 });
    return Response.json({
      credential: { id: credential.id, email: credential.email, accountId: credential.accountId, planType: credential.planType },
      events: listCredentialQuotaResetEvents(id),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
