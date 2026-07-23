import { errorToResponse } from "@/src/server/http/errors";
import { parseProviderId } from "@/src/server/services/providerCredentials";
import { getProviderQuota } from "@/src/server/services/providerQuota";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string; id: string }> },
) {
  let provider = "";
  let id = "";
  try {
    requireWebRequest(request);
    ({ provider, id } = await context.params);
    const searchParams = new URL(request.url).searchParams;
    return Response.json(
      await getProviderQuota(parseProviderId(provider), id, {
        forceRefresh:
          searchParams.get("refresh") === "1" ||
          searchParams.get("force") === "1",
        includeRaw: searchParams.get("raw") === "1",
      }),
    );
  } catch (error) {
    return errorToResponse(error, {
      operation: "provider.quota.refresh",
      request,
      metadata: {
        ...(provider ? { provider } : {}),
        ...(id ? { credentialId: id } : {}),
      },
    });
  }
}
