import { cookies } from "next/headers";
import { errorToResponse } from "@/src/server/http/errors";
import { changeTenantPassword, createTenantSessionToken, requireTenantRequest, TENANT_SESSION_COOKIE, tenantSessionCookieOptions } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = requireTenantRequest(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const updated = changeTenantPassword(context, body?.currentPassword, body?.newPassword);
    (await cookies()).set(TENANT_SESSION_COOKIE, createTenantSessionToken(updated), tenantSessionCookieOptions(request));
    return Response.json({ changed: true });
  } catch (error) { return errorToResponse(error); }
}
