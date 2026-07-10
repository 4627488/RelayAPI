import { errorToResponse } from "@/src/server/http/errors";
import { refreshLiteLlmPricing } from "@/src/server/services/quotaAdministration";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(await refreshLiteLlmPricing());
  } catch (error) {
    return errorToResponse(error);
  }
}
