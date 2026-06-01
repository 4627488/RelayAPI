import { errorToResponse } from "@/src/server/http/errors";
import {
  createTenantApiKey,
  listTenantApiKeyPublicRecords,
} from "@/src/server/services/apiKeys";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    return Response.json({
      object: "list",
      data: listTenantApiKeyPublicRecords(context.tenant.id),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = requireTenantRequest(request);
    const body = await request.json();
    return Response.json(createTenantApiKey(context.tenant, body), {
      status: 201,
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
