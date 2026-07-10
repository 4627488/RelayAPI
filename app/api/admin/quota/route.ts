import { errorToResponse } from "@/src/server/http/errors";
import {
  getQuotaAdministration,
  patchQuotaAdministration,
} from "@/src/server/services/quotaAdministration";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(getQuotaAdministration());
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(patchQuotaAdministration(await request.json()));
  } catch (error) {
    return errorToResponse(error);
  }
}
