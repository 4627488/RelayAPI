import { errorToResponse } from "@/src/server/http/errors";
import { parseProviderId, patchProviderCredential, removeProviderCredential } from "@/src/server/services/providerCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ provider: string; id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    requireWebRequest(request);
    const { provider, id } = await context.params;
    return Response.json(await patchProviderCredential(parseProviderId(provider), id, await request.json() as Record<string, unknown>));
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireWebRequest(request);
    const { provider, id } = await context.params;
    await removeProviderCredential(parseProviderId(provider), id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorToResponse(error);
  }
}
