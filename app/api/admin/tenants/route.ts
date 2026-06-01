import { errorToResponse } from "@/src/server/http/errors";
import {
  createTenant,
  listPublicTenants,
} from "@/src/server/services/tenants";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json({
      object: "list",
      data: listPublicTenants(),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json();
    return Response.json(createTenant(body), { status: 201 });
  } catch (error) {
    return errorToResponse(error);
  }
}
