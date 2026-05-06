import { errorToResponse } from "@/src/server/http/errors";
import {
  getPublicGlobalSettings,
  patchGlobalSettings,
} from "@/src/server/services/settings";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(getPublicGlobalSettings());
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json();
    return Response.json(patchGlobalSettings(body));
  } catch (error) {
    return errorToResponse(error);
  }
}
