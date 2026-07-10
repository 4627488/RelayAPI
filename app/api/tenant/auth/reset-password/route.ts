import { cookies } from "next/headers";
import { errorToResponse } from "@/src/server/http/errors";
import { completeTenantPasswordReset, createTenantSessionToken, TENANT_SESSION_COOKIE, tenantSessionCookieOptions } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const context = completeTenantPasswordReset(body?.token, body?.password);
    (await cookies()).set(TENANT_SESSION_COOKIE, createTenantSessionToken(context), tenantSessionCookieOptions(request));
    return Response.json({ reset: true });
  } catch (error) { return errorToResponse(error); }
}
