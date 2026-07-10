import { errorToResponse } from "@/src/server/http/errors";
import { createTenantPasswordReset } from "@/src/server/services/tenants";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    return Response.json(createTenantPasswordReset(id), { status: 201 });
  } catch (error) { return errorToResponse(error); }
}
