import { errorToResponse } from "@/src/server/http/errors";
import {
  getPublicGlobalSettings,
  patchGlobalSettings,
} from "@/src/server/services/settings";
import { maybeAutoPruneRequestLogs } from "@/src/server/services/logRetention";
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
    const settings = patchGlobalSettings(body);
    if (hasRequestLogRetentionPatch(body)) {
      maybeAutoPruneRequestLogs({ force: true });
    }
    return Response.json(settings);
  } catch (error) {
    return errorToResponse(error);
  }
}

function hasRequestLogRetentionPatch(body: unknown) {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (Object.hasOwn(body, "requestLogRetentionDays") ||
      Object.hasOwn(body, "requestLogDetailRetentionDays"))
  );
}
