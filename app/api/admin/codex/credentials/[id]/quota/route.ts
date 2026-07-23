import { errorToResponse } from "@/src/server/http/errors";
import { getProviderQuota } from "@/src/server/services/providerQuota";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Quota cache stays in the main DB so future automatic channel routing can use it.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    requireWebRequest(request);
    ({ id } = await context.params);
    const searchParams = new URL(request.url).searchParams;
    return Response.json(
      await getProviderQuota("codex", id, {
        forceRefresh:
          searchParams.get("refresh") === "1" ||
          searchParams.get("force") === "1",
        includeRaw: searchParams.get("raw") === "1",
      }),
    );
  } catch (error) {
    return errorToResponse(error, {
      operation: "codex.quota.refresh",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}
