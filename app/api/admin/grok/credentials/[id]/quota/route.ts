import { errorToResponse } from "@/src/server/http/errors";
import { requireWebRequest } from "@/src/server/services/webAccess";
import { getProviderQuota } from "@/src/server/services/providerQuota";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { requireWebRequest(request); const { id } = await context.params; return Response.json(await getProviderQuota("grok", id)); }
  catch (error) { return errorToResponse(error); }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
