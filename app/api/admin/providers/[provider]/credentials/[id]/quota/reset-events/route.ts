import { errorToResponse } from "@/src/server/http/errors";
import { listCredentialQuotaResetEvents } from "@/src/server/repositories/credentialQuotaResetEvents";
import { listProviderCredentials } from "@/src/server/repositories/providerCredentials";
import { parseProviderId } from "@/src/server/services/providerCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string; id: string }> },
) {
  try {
    requireWebRequest(request);
    const { provider: rawProvider, id } = await context.params;
    const provider = parseProviderId(rawProvider);
    const credential = listProviderCredentials(provider).find(
      (item) => item.id === id,
    );
    if (!credential) {
      return Response.json({ error: "Credential not found" }, { status: 404 });
    }
    return Response.json({
      credential: {
        id: credential.id,
        provider: credential.provider,
        email: credential.email,
        accountId:
          credential.provider === "codex"
            ? credential.accountId
            : credential.subject,
        planType: credential.planType,
      },
      events: listCredentialQuotaResetEvents(id),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
