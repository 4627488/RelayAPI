import { errorToResponse } from "@/src/server/http/errors";
import { rotateOidcClientSecret } from "@/src/server/services/settings";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(rotateOidcClientSecret());
  } catch (error) {
    return errorToResponse(error);
  }
}
