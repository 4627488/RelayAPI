import { listUpstreamModelIds } from "@/src/server/codex/models";
import { errorToResponse } from "@/src/server/http/errors";
import { requireTenantRequest } from "@/src/server/services/tenants";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireAuthorizedSession(request);
    return Response.json({ object: "list", data: await listUpstreamModelIds() });
  } catch (error) {
    return errorToResponse(error);
  }
}

function requireAuthorizedSession(request: Request) {
  try {
    requireWebRequest(request);
    return;
  } catch {
    requireTenantRequest(request);
  }
}
