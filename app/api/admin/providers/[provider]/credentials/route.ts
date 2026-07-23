import { errorToResponse } from "@/src/server/http/errors";
import { listPublicProviderCredentials, parseProviderId } from "@/src/server/services/providerCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    requireWebRequest(request);
    const { provider } = await context.params;
    return Response.json(await listPublicProviderCredentials(parseProviderId(provider)));
  } catch (error) {
    return errorToResponse(error);
  }
}
